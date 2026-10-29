import contextlib
import importlib.util
import json
import sys
import types
import unittest
from unittest.mock import patch


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
        self.turns = turns
        self.turn = ""
        self.begun = False

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
        self.messages = []
        self.broadcasts = []

        async def send(text_data):
            self.messages.append(json.loads(text_data))

        async def group_send(group, event):
            self.broadcasts.append((group, event))

        self.consumer.send = send
        self.consumer.channel_layer = types.SimpleNamespace(group_send=group_send)

    async def test_confirmation_and_concurrent_duplicate(self):
        await self.consumer.receive("round_advance,3,Player 1/")
        self.assertEqual(self.game.turns, (
            "round_complete,3,Player 1/round_advance,3,Player 1/"
        ))
        self.assertEqual(self.messages[-1], {
            "type": "game_action", "action": "round_advance,3,Player 1"
        })
        self.assertEqual(len(self.broadcasts), 1)

        await self.consumer.receive("round_advance,3,Player 2/")
        self.assertEqual(self.messages[-1], {
            "type": "game_action", "action": "round_advance,3,Player 1"
        })
        self.assertEqual(len(self.broadcasts), 1)
        self.assertEqual(self.game.turns.count("round_advance"), 1)

    async def test_missing_round_completion_is_reported(self):
        self.game.turns = ""
        await self.consumer.receive("round_advance,3,Player 1/")
        self.assertEqual(self.messages, [{
            "type": "game_action_error",
            "action": "round_advance,3,Player 1",
        }])
        self.assertEqual(self.game.turns, "")
        self.assertEqual(self.broadcasts, [])


if __name__ == "__main__":
    unittest.main()
