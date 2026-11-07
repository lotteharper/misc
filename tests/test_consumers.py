import contextlib
import importlib.util
import json
import sys
import types
import unittest
from unittest.mock import AsyncMock, patch


def load_consumers():
    modules = {
        name: types.ModuleType(name)
        for name in (
            "channels",
            "channels.db",
            "channels.generic",
            "channels.generic.websocket",
            "django",
            "django.db",
            "django.utils",
            "games",
            "games.models",
        )
    }

    def database_sync_to_async(function):
        async def wrapper(*args, **kwargs):
            return function(*args, **kwargs)
        return wrapper

    modules["channels.db"].database_sync_to_async = database_sync_to_async
    modules["channels.generic.websocket"].AsyncWebsocketConsumer = type(
        "AsyncWebsocketConsumer", (), {}
    )
    modules["django.db"].transaction = types.SimpleNamespace(
        atomic=contextlib.nullcontext
    )
    modules["django.utils"].timezone = types.SimpleNamespace()
    modules["games.models"].Game = type("Game", (), {})

    spec = importlib.util.spec_from_file_location("consumers_under_test", "consumers.py")
    module = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, modules):
        spec.loader.exec_module(module)
    return module


consumers = load_consumers()


class FakeGame:
    def __init__(self, turns):
        self.id = 42
        self.uid = "host-code"
        self.code = "guest-code"
        self.turns = turns
        self.turn = ""
        self.begun = False
        self.players = consumers.BOTH_PLAYERS
        self.player1_score = None
        self.player2_score = None
        self.scored = False

    def save(self, update_fields):
        pass


class FakeQuery:
    def __init__(self, game):
        self.game = game

    def select_for_update(self):
        return self

    def filter(self, **kwargs):
        return self

    def first(self):
        return self.game


class ConsumerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.game = FakeGame("round_complete,3,Player 1/")
        consumers.Game.objects = FakeQuery(self.game)
        self.consumer = consumers.GameConsumer()
        self.consumer.game_id = 42
        self.consumer.group_name = "game_42"
        self.consumer.channel_name = "sender"
        self.consumer.player = "Player 1"
        self.messages = []
        self.broadcasts = []

        async def send(text_data):
            self.messages.append(json.loads(text_data))

        async def group_send(group, event):
            self.broadcasts.append((group, event))

        self.consumer.send = send
        self.consumer.channel_layer = types.SimpleNamespace(group_send=group_send)

    async def test_both_players_must_be_ready_and_retries_are_idempotent(self):
        await self.consumer.receive("round_ready,3,Player 1/")
        self.assertEqual(self.game.turns, (
            "round_complete,3,Player 1/round_ready,3,Player 1/"
        ))
        self.assertEqual(self.messages[-1], {
            "type": "game_action", "action": "round_ready,3,Player 1"
        })
        self.assertEqual(len(self.broadcasts), 1)

        await self.consumer.receive("round_ready,3,Player 1/")
        self.assertEqual(self.game.turns.count("round_ready"), 1)
        self.assertEqual(len(self.broadcasts), 1)

        self.consumer.player = "Player 2"
        await self.consumer.receive("round_ready,3,Player 2/")
        self.assertEqual(self.game.turns, (
            "round_complete,3,Player 1/round_ready,3,Player 1/"
            "round_ready,3,Player 2/round_advance,3,Player 2/"
        ))
        self.assertEqual(self.messages[-1], {
            "type": "game_action", "action": "round_advance,3,Player 2"
        })
        self.assertEqual(len(self.broadcasts), 3)

        self.consumer.player = "Player 1"
        await self.consumer.receive("round_ready,3,Player 1/")
        self.assertEqual(self.messages[-1]["type"], "game_state")
        self.assertIn("round_advance,3,Player 2", self.messages[-1]["history"])
        self.assertEqual(len(self.broadcasts), 3)
        self.assertEqual(self.game.turns.count("round_advance"), 1)

    async def test_missing_round_completion_is_reported(self):
        self.game.turns = ""
        await self.consumer.receive("round_ready,3,Player 1/")
        self.assertEqual(self.messages[0]["type"], "game_action_error")
        self.assertEqual(self.messages[0]["action"], "round_ready,3,Player 1")
        self.assertEqual(self.messages[0]["state"]["history"], [])
        self.assertEqual(self.game.turns, "")
        self.assertEqual(self.broadcasts, [])

    async def test_client_cannot_advance_directly_or_use_unknown_player(self):
        await self.consumer.receive("round_advance,3,Player 1/")
        await self.consumer.receive("round_ready,3,Spectator/")
        self.assertEqual(self.messages[0]["type"], "game_action_error")
        self.assertEqual(self.messages[0]["action"], "round_advance,3,Player 1")
        self.assertEqual(self.game.turns, "round_complete,3,Player 1/")
        self.assertEqual(self.broadcasts, [])

    async def test_legacy_advance_rejects_late_readiness(self):
        self.game.turns += "round_advance,3,Player 1/"
        self.consumer.player = "Player 2"
        await self.consumer.receive("round_ready,3,Player 2/")
        self.assertEqual(self.messages[-1]["type"], "game_action_error")
        self.assertEqual(self.broadcasts, [])

    async def test_moves_require_both_distinct_slots_and_correct_actor(self):
        self.game.turns = ""
        for slots in (0, 1, 2):
            self.game.players = slots
            for action in ("draw,deck,Player 1", "discard,4.2,Player 1",
                           "round_complete,3,Player 1", "round_ready,3,Player 1"):
                await self.consumer.receive(action)
                self.assertEqual(self.messages[-1]["type"], "game_action_error")
                self.assertFalse(self.messages[-1]["state"]["players_connected"])
                self.assertEqual(self.game.turns, "")

        self.game.players = consumers.BOTH_PLAYERS
        await self.consumer.receive("draw,deck,Player 2")
        self.assertEqual(self.messages[-1]["type"], "game_action_error")
        self.assertEqual(self.game.turns, "")
        await self.consumer.receive("draw,deck,Player 1")
        self.assertEqual(self.game.turns, "draw,deck,Player 1/")
        self.assertEqual(self.messages[-1], {
            "type": "game_action", "action": "draw,deck,Player 1",
        })

        self.game.players = 1
        await self.consumer.receive("discard,4.2,Player 1")
        self.assertEqual(self.game.turns, "draw,deck,Player 1/")
        self.assertEqual(len(self.broadcasts), 1)

    async def test_slot_claims_are_distinct_and_can_be_reclaimed(self):
        self.game.players = 0
        self.assertTrue(await consumers.claim_player_slot(42, "Player 1"))
        self.assertFalse(await consumers.claim_player_slot(42, "Player 1"))
        self.assertEqual(self.game.players, 1)
        self.assertTrue(await consumers.claim_player_slot(42, "Player 2"))
        self.assertEqual(self.game.players, consumers.BOTH_PLAYERS)
        await consumers.release_player_slot(42, "Player 1")
        self.assertEqual(self.game.players, 2)
        self.assertTrue(await consumers.claim_player_slot(42, "Player 1"))
        self.assertEqual(self.game.players, consumers.BOTH_PLAYERS)

    async def test_connections_broadcast_presence_and_reject_duplicate_slot(self):
        self.game.players = 0
        group_events = []

        async def group_add(group, channel):
            group_events.append(("add", group, channel))

        async def group_discard(group, channel):
            group_events.append(("discard", group, channel))

        async def group_send(group, event):
            group_events.append(("send", group, event))

        def make_connection(player, channel):
            connection = consumers.GameConsumer()
            connection.scope = {
                "url_route": {"kwargs": {"id": "1", "code": "code"}},
                "query_string": ("player=" + player.replace(" ", "+")).encode(),
            }
            connection.channel_name = channel
            connection.channel_layer = types.SimpleNamespace(
                group_add=group_add, group_discard=group_discard, group_send=group_send,
            )
            connection.accept = AsyncMock()
            connection.close = AsyncMock()
            connection.send = AsyncMock()
            return connection

        first = make_connection("Player 1", "first")
        duplicate = make_connection("Player 1", "duplicate")
        second = make_connection("Player 2", "second")
        with patch.object(consumers, "get_game_for_connection", AsyncMock(return_value=self.game)):
            await first.connect()
            self.assertFalse(json.loads(first.send.call_args.kwargs["text_data"])["players_connected"])
            await duplicate.connect()
            duplicate.close.assert_awaited_once_with(code=4009)
            self.assertEqual(self.game.players, 1)
            await second.connect()
            self.assertTrue(json.loads(second.send.call_args.kwargs["text_data"])["players_connected"])
            await first.game_presence({})
            self.assertTrue(json.loads(first.send.call_args.kwargs["text_data"])["players_connected"])
            await second.disconnect(1000)
            await first.game_presence({})
            self.assertFalse(json.loads(first.send.call_args.kwargs["text_data"])["players_connected"])
            self.assertEqual(self.game.players, 1)
            await second.connect()
            self.assertEqual(self.game.players, consumers.BOTH_PLAYERS)
        self.assertEqual(sum(event[0] == "send" for event in group_events), 4)

    async def test_legacy_connections_use_game_codes_to_claim_distinct_slots(self):
        self.game.players = 0
        self.game.code = "3559"

        def make_connection(code, query=b""):
            connection = consumers.GameConsumer()
            connection.scope = {
                "url_route": {"kwargs": {"id": "101", "code": code}},
                "query_string": query,
            }
            connection.channel_name = code
            connection.channel_layer = types.SimpleNamespace(
                group_add=AsyncMock(), group_discard=AsyncMock(), group_send=AsyncMock(),
            )
            connection.accept = AsyncMock()
            connection.close = AsyncMock()
            connection.send = AsyncMock()
            return connection

        host = make_connection("host-code")
        guest = make_connection("3559", b"other=value")
        duplicate = make_connection("host-code")
        with patch.object(consumers, "get_game_for_connection", AsyncMock(return_value=self.game)):
            await host.connect()
            host.accept.assert_awaited_once()
            self.assertEqual(host.player, "Player 1")
            self.assertFalse(json.loads(host.send.call_args.kwargs["text_data"])["players_connected"])
            await guest.connect()
            guest.accept.assert_awaited_once()
            self.assertEqual(guest.player, "Player 2")
            self.assertTrue(json.loads(guest.send.call_args.kwargs["text_data"])["players_connected"])
            await duplicate.connect()
            duplicate.close.assert_awaited_once_with(code=4009)
            self.assertEqual(self.game.players, consumers.BOTH_PLAYERS)
            await host.receive("draw,deck,Player 1/")
            self.assertEqual(self.game.turns, "round_complete,3,Player 1/draw,deck,Player 1/")
            await host.disconnect(1000)
            self.assertEqual(self.game.players, 2)

    async def test_missing_or_invalid_player_cannot_select_an_ambiguous_slot(self):
        self.game.players = 0

        async def reject(code, query):
            connection = consumers.GameConsumer()
            connection.scope = {
                "url_route": {"kwargs": {"id": "101", "code": code}},
                "query_string": query,
            }
            connection.accept = AsyncMock()
            connection.close = AsyncMock()
            await connection.connect()
            connection.close.assert_awaited_once_with(code=4000)
            connection.accept.assert_not_awaited()

        with patch.object(consumers, "get_game_for_connection", AsyncMock(return_value=self.game)):
            await reject("unknown", b"")
            await reject("host-code", b"player=")
            await reject("host-code", b"player=Player+1&player=Player+2")
            await reject("host-code", b"player=Spectator")
            self.game.code = self.game.uid
            await reject("host-code", b"")
        self.assertEqual(self.game.players, 0)


if __name__ == "__main__":
    unittest.main()
