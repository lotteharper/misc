import asyncio
import contextlib
import importlib.util
import json
import sys
import time
import types
import unittest
from unittest.mock import AsyncMock, MagicMock, patch


def load_consumers():
    names = ("channels", "channels.db", "channels.generic",
             "channels.generic.websocket", "django", "django.db",
             "django.db.models", "django.utils", "world", "world.models")
    modules = {name: types.ModuleType(name) for name in names}

    def database_sync_to_async(function):
        async def wrapper(*args, **kwargs):
            return function(*args, **kwargs)
        return wrapper

    modules["channels.db"].database_sync_to_async = database_sync_to_async
    modules["channels.generic.websocket"].AsyncWebsocketConsumer = type(
        "AsyncWebsocketConsumer", (), {}
    )
    modules["django.db"].transaction = types.SimpleNamespace(atomic=contextlib.nullcontext)
    modules["django.db.models"].Q = MagicMock()
    modules["django.utils"].timezone = types.SimpleNamespace(now=lambda: None)
    for name in ("WorldArrow", "WorldBlockEdit", "WorldConnection", "WorldContainer", "WorldDrop", "WorldPlayer"):
        setattr(modules["world.models"], name, type(name, (), {}))
    spec = importlib.util.spec_from_file_location("world.game_consumers", "game_consumers.py")
    module = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, modules):
        spec.loader.exec_module(module)
    return module


consumers = load_consumers()
ARROW_ID = "c9592f76-a6ee-43df-bffa-30f17dff2d68"
PLAYER_ID = "950af13b-daf2-4c0a-b93b-d5778a698987"
TARGET_ID = "e8353637-1469-4aea-9cb6-5361bc56ab60"


class WorldConsumerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.consumer = consumers.WorldConsumer()
        self.consumer.room = "lobby"
        self.consumer.room_group = "world_lobby"
        self.consumer.player_id = PLAYER_ID
        self.consumer.flying_arrows = set()
        self.consumer.connection_claimed = True
        self.consumer.lease_deadline = time.monotonic() + 60
        self.consumer.channel_layer = types.SimpleNamespace(group_send=AsyncMock())
        self.consumer.send_json = AsyncMock()

    def test_inventory_accepts_game_items(self):
        inventory = [None] * 27
        inventory[0] = {"type": "bow", "color": "#9b6738", "count": 1}
        inventory[1] = {"type": "arrows", "color": "#d5d5d5", "count": 4}
        inventory[2] = {"type": "diamond_sword", "color": "#6cf0f2", "count": 1}
        inventory[3] = {"type": "apple", "color": "#d83930", "count": 3}
        inventory[4] = {"type": "wood_slab", "color": "#b98240", "count": 2}
        inventory[5] = {"type": "stone_slab", "color": "#777b80", "count": 2}
        inventory[6] = {"type": "wood_stairs", "color": "#b98250", "count": 4}
        inventory[7] = {"type": "stone_stairs", "color": "#777b90", "count": 4}
        self.assertEqual(consumers.clean_inventory(inventory), inventory)
        for item in inventory[4:8]:
            self.assertEqual(consumers.clean_item(item), item)

    async def test_authenticated_username_is_broadcast_on_connect_and_movement(self):
        self.consumer.scope = {
            "user": types.SimpleNamespace(pk=1, username="Alice", is_authenticated=True),
            "url_route": {"kwargs": {"room": "lobby"}},
        }
        self.consumer.channel_name = "test-channel"
        self.consumer.channel_layer.group_add = AsyncMock()
        self.consumer.accept = AsyncMock()
        self.consumer.claim_connection = AsyncMock(return_value=[])
        position = {"x": 1, "y": 2, "z": 3, "yaw": 0, "pitch": 0}
        self.consumer.load_player_state = AsyncMock(return_value={
            "player_id": PLAYER_ID, "position": position, "inventory": [], "players": [],
        })
        for name in ("clear_stale_arrows", "load_room_edits", "load_room_containers",
                     "load_landed_arrows", "load_drops"):
            setattr(self.consumer, name, AsyncMock(return_value=[]))
        with patch.object(consumers, "get_name", AsyncMock(return_value="Alice")):
            await self.consumer.connect()
        self.assertEqual(self.consumer.channel_layer.group_send.await_args.args[1]["message"], {
            "type": "player_state", "player_id": PLAYER_ID,
            "username": "Alice", "position": position,
        })
        self.consumer.save_position = AsyncMock()
        await self.consumer.receive(json.dumps({
            "type": "position", "position": position, "username": "Impostor",
        }))
        self.assertEqual(self.consumer.channel_layer.group_send.await_args.args[1]["message"]["username"],
                         "Alice")
        self.consumer.lease_task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await self.consumer.lease_task

    async def test_duplicate_connection_does_not_initialize_or_clean_up_player(self):
        self.consumer = consumers.WorldConsumer()
        self.consumer.scope = {
            "user": types.SimpleNamespace(pk=1, is_authenticated=True),
            "url_route": {"kwargs": {"room": "other-room"}},
        }
        self.consumer.claim_connection = AsyncMock(return_value=None)
        self.consumer.accept = AsyncMock()
        self.consumer.send_json = AsyncMock()
        self.consumer.close = AsyncMock()
        self.consumer.load_player_state = AsyncMock()
        self.consumer.release_connection = AsyncMock()
        await self.consumer.connect()
        self.consumer.send_json.assert_awaited_once_with({"type": "connection_blocked"})
        self.consumer.close.assert_awaited_once_with(code=4409)
        self.consumer.load_player_state.assert_not_awaited()
        await self.consumer.disconnect(4409)
        self.consumer.release_connection.assert_not_awaited()

    async def test_expired_connection_rejects_actions(self):
        self.consumer.lease_deadline = time.monotonic() - 1
        self.consumer.close = AsyncMock()
        self.consumer.receive_position = AsyncMock()
        await self.consumer.receive(json.dumps({"type": "position", "position": {}}))
        self.consumer.receive_position.assert_not_awaited()
        self.consumer.close.assert_awaited_once_with(code=4410)
        await self.consumer.room_message({"message": {"type": "player_state"}})
        self.consumer.send_json.assert_not_awaited()

    async def test_startup_error_releases_connection(self):
        self.consumer = consumers.WorldConsumer()
        self.consumer.scope = {
            "user": types.SimpleNamespace(pk=1, is_authenticated=True),
            "url_route": {"kwargs": {"room": "lobby"}},
        }
        self.consumer.claim_connection = AsyncMock(return_value=[])
        self.consumer.release_connection = AsyncMock(return_value=(True, []))
        with patch.object(consumers, "get_name", AsyncMock(side_effect=RuntimeError("failed"))):
            with self.assertRaisesRegex(RuntimeError, "failed"):
                await self.consumer.connect()
        self.consumer.release_connection.assert_awaited_once()
        self.assertTrue(self.consumer.lease_task.cancelled())

    async def test_welcome_snapshot_contains_other_usernames(self):
        player = types.SimpleNamespace(pk=1, player_id=PLAYER_ID, position={},
                                       inventory=[None] * 27, save=MagicMock())
        manager = MagicMock()
        manager.get_or_create.return_value = (player, True)
        manager.filter.return_value.exclude.return_value.values.return_value = [{
            "player_id": TARGET_ID, "position": {"x": 1, "y": 2, "z": 3},
            "user__profile__name": "Bob",
        }]
        self.consumer.user_id = 1
        with patch.object(consumers.WorldPlayer, "objects", manager, create=True):
            state = await self.consumer.load_player_state()
        self.assertEqual(state["players"], [{
            "id": TARGET_ID, "position": {"x": 1, "y": 2, "z": 3}, "username": "Bob",
        }])
        manager.filter.return_value.exclude.return_value.values.assert_called_once_with(
            "player_id", "position", "user__profile__name")

    async def test_combat_is_targeted_and_validated(self):
        self.consumer.player_is_online = AsyncMock(return_value=True)
        await self.consumer.receive(json.dumps({
            "type": "combat", "target_id": TARGET_ID, "damage": 5,
        }))
        event = self.consumer.channel_layer.group_send.await_args.args[1]
        self.assertEqual(event, {"type": "targeted.damage", "target_id": TARGET_ID, "amount": 5})
        await self.consumer.targeted_damage(event)
        self.consumer.send_json.assert_not_awaited()
        self.consumer.player_id = TARGET_ID
        await self.consumer.targeted_damage(event)
        self.consumer.send_json.assert_awaited_once_with({"type": "damage", "amount": 5})
        self.consumer.channel_layer.group_send.reset_mock()
        await self.consumer.receive_combat({"target_id": PLAYER_ID, "damage": float("nan")})
        await self.consumer.receive_combat({"target_id": TARGET_ID, "damage": 5})
        self.consumer.channel_layer.group_send.assert_not_awaited()

    async def test_base_rejects_all_edits(self):
        self.consumer.persist_world_edit = AsyncMock()
        for y in (-25, -24):
            await self.consumer.receive_world_edit({"x": 0, "y": y, "z": 0, "color": None})
            await self.consumer.receive_world_edit({"x": 0, "y": y, "z": 0, "color": "#ffffff"})
        self.consumer.persist_world_edit.assert_not_awaited()
        await self.consumer.receive_world_edit({"x": 0, "y": -23, "z": 0, "color": "#ffffff"})
        self.consumer.persist_world_edit.assert_awaited_once()

    async def test_arrow_lifecycle_broadcast_and_pickup(self):
        self.consumer.create_arrow = AsyncMock(return_value=True)
        self.consumer.land_arrow = AsyncMock(return_value=True)
        self.consumer.pick_up_arrow = AsyncMock(return_value=[None] * 27)
        data = {"arrow_id": ARROW_ID, "position": [1, 2, 3], "direction": [0, 0, 1]}
        await self.consumer.receive(json.dumps({"type": "arrow_spawn", **data}))
        self.assertIn(ARROW_ID, self.consumer.flying_arrows)
        event = self.consumer.channel_layer.group_send.await_args.args[1]["message"]
        self.assertEqual(event["owner_id"], PLAYER_ID)
        await self.consumer.receive(json.dumps({"type": "arrow_land", **data}))
        self.assertNotIn(ARROW_ID, self.consumer.flying_arrows)
        await self.consumer.receive(json.dumps({"type": "arrow_pickup", "arrow_id": ARROW_ID}))
        self.consumer.send_json.assert_awaited_once_with({
            "type": "arrow_picked_up", "arrow_id": ARROW_ID, "inventory": [None] * 27,
        })
        self.assertEqual(self.consumer.channel_layer.group_send.await_args.args[1]["message"],
                         {"type": "arrow_remove", "arrow_id": ARROW_ID})

    async def test_invalid_and_failed_pickups_do_not_broadcast(self):
        self.consumer.create_arrow = AsyncMock(return_value=True)
        self.consumer.pick_up_arrow = AsyncMock(return_value=None)
        await self.consumer.receive_arrow_spawn({
            "arrow_id": ARROW_ID, "position": [1, 2, 3], "direction": [0, 0, 0],
        })
        self.consumer.create_arrow.assert_not_awaited()
        await self.consumer.receive_arrow_pickup({"arrow_id": ARROW_ID})
        self.consumer.send_json.assert_awaited_once_with({
            "type": "arrow_pickup_failed", "arrow_id": ARROW_ID,
        })
        self.consumer.channel_layer.group_send.assert_not_awaited()

    async def test_leaf_decay_and_drop_pickup(self):
        drop = {"drop_id": ARROW_ID, "item_type": "apple", "position": [1.5, 2.15, 3.5]}
        self.consumer.decay_leaf = AsyncMock(return_value=drop)
        self.consumer.pick_up_drop = AsyncMock(return_value=[None] * 27)
        await self.consumer.receive(json.dumps({
            "type": "leaf_decay", "x": 1, "y": 5, "z": 3,
            "item_type": "apple", "position": drop["position"],
        }))
        self.assertEqual(self.consumer.channel_layer.group_send.await_args.args[1]["message"],
                         {"type": "leaf_decayed", "edit": {
                             "x": 1, "y": 5, "z": 3, "color": None}, "drop": drop})
        await self.consumer.receive(json.dumps({"type": "drop_pickup", "drop_id": ARROW_ID}))
        self.consumer.send_json.assert_awaited_once_with({
            "type": "drop_picked_up", "drop_id": ARROW_ID, "inventory": [None] * 27,
        })
        self.assertEqual(self.consumer.channel_layer.group_send.await_args.args[1]["message"],
                         {"type": "drop_remove", "drop_id": ARROW_ID})

    async def test_invalid_leaf_decay_is_rejected(self):
        self.consumer.decay_leaf = AsyncMock()
        for item, position in [("stone", [1.5, 2, 3.5]), ("apple", [20, 2, 3.5]),
                               ("apple", [1.5, 20, 3.5])]:
            await self.consumer.receive_leaf_decay({
                "x": 1, "y": 5, "z": 3, "item_type": item, "position": position,
            })
        self.consumer.decay_leaf.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
