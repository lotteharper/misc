import contextlib
import importlib.util
import json
import sys
import types
import unittest
from unittest.mock import AsyncMock, patch


def load_consumers():
    names = ("channels", "channels.db", "channels.generic",
             "channels.generic.websocket", "django", "django.db",
             "django.utils", "world", "world.models")
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
    modules["django.utils"].timezone = types.SimpleNamespace(now=lambda: None)
    for name in ("WorldArrow", "WorldBlockEdit", "WorldContainer", "WorldDrop", "WorldPlayer"):
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
        self.consumer.channel_layer = types.SimpleNamespace(group_send=AsyncMock())
        self.consumer.send_json = AsyncMock()

    def test_inventory_accepts_game_items(self):
        inventory = [None] * 27
        inventory[0] = {"type": "bow", "color": "#9b6738", "count": 1}
        inventory[1] = {"type": "arrows", "color": "#d5d5d5", "count": 4}
        inventory[2] = {"type": "diamond_sword", "color": "#6cf0f2", "count": 1}
        inventory[3] = {"type": "apple", "color": "#d83930", "count": 3}
        self.assertEqual(consumers.clean_inventory(inventory), inventory)

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
