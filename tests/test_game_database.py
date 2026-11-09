import importlib
import importlib.util
import os
import shutil
import sys
import tempfile
import unittest
import uuid


HAS_DJANGO = importlib.util.find_spec("django") is not None
HAS_CHANNELS = importlib.util.find_spec("channels") is not None


@unittest.skipUnless(HAS_DJANGO and HAS_CHANNELS, "Django and Channels are not installed")
class ArrowDatabaseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        from django.conf import settings
        if settings.configured:
            raise unittest.SkipTest("requires isolated Django settings")
        cls.temp = tempfile.TemporaryDirectory()
        package = os.path.join(cls.temp.name, "world_test_app")
        os.mkdir(package)
        open(os.path.join(package, "__init__.py"), "w").close()
        shutil.copyfile("game_models.py", os.path.join(package, "models.py"))
        shutil.copyfile("game_consumers.py", os.path.join(package, "consumers.py"))
        sys.path.insert(0, cls.temp.name)
        settings.configure(
            SECRET_KEY="test",
            INSTALLED_APPS=["django.contrib.auth", "django.contrib.contenttypes", "world_test_app"],
            DATABASES={"default": {"ENGINE": "django.db.backends.sqlite3",
                                   "NAME": os.path.join(cls.temp.name, "world.sqlite3")}},
            USE_TZ=True,
        )
        import django
        django.setup()
        from django.contrib.auth import get_user_model
        from django.db import connection
        cls.models = importlib.import_module("world_test_app.models")
        cls.consumer_class = importlib.import_module("world_test_app.consumers").WorldConsumer
        cls.user_class = get_user_model()
        with connection.schema_editor() as editor:
            editor.create_model(cls.user_class)
            editor.create_model(cls.models.WorldPlayer)
            editor.create_model(cls.models.WorldArrow)
            editor.create_model(cls.models.WorldBlockEdit)
            editor.create_model(cls.models.WorldDrop)

    @classmethod
    def tearDownClass(cls):
        from django.db import connections
        connections.close_all()
        sys.path.remove(cls.temp.name)
        cls.temp.cleanup()
        super().tearDownClass()

    def setUp(self):
        self.models.WorldArrow.objects.all().delete()
        self.models.WorldBlockEdit.objects.all().delete()
        self.models.WorldDrop.objects.all().delete()
        self.models.WorldPlayer.objects.all().delete()
        user = self.user_class.objects.create(username=str(uuid.uuid4()))
        self.player = self.models.WorldPlayer.objects.create(user=user, room="lobby")
        self.consumer = self.consumer_class()
        self.consumer.room = "lobby"
        self.consumer.user_id = user.pk
        self.consumer.player_id = str(self.player.player_id)
        self.consumer.last_position = {"x": 1, "y": 2, "z": 3}
        self.arrow_id = "c9592f76-a6ee-43df-bffa-30f17dff2d68"

    def test_arrow_pickup_is_persisted_and_only_awarded_once(self):
        from asgiref.sync import async_to_sync
        self.assertTrue(async_to_sync(self.consumer.create_arrow)(
            self.arrow_id, [1, 2.85, 3], [0, 0, 1]))
        self.assertTrue(async_to_sync(self.consumer.land_arrow)(
            self.arrow_id, [1, 2.85, 3], [0, 0, 1]))
        result = async_to_sync(self.consumer.pick_up_arrow)(self.arrow_id)
        self.assertEqual(result[0], {"type": "arrows", "color": "#d5d5d5", "count": 1})
        self.player.refresh_from_db()
        self.assertEqual(self.player.inventory, result)
        self.assertIsNone(async_to_sync(self.consumer.pick_up_arrow)(self.arrow_id))
        self.assertFalse(self.models.WorldArrow.objects.exists())

    def test_pickup_rejects_full_inventory_and_distant_players(self):
        from asgiref.sync import async_to_sync
        self.models.WorldArrow.objects.create(
            arrow_id=self.arrow_id, room="lobby", owner_id=self.player.player_id,
            position=[1, 2.85, 3], direction=[0, 0, 1], landed=True,
        )
        self.consumer.last_position = {"x": 50, "y": 2, "z": 3}
        self.assertIsNone(async_to_sync(self.consumer.pick_up_arrow)(self.arrow_id))
        self.consumer.last_position = {"x": 1, "y": 2, "z": 3}
        self.player.inventory = [{"type": "stone", "color": "#777b82", "count": 64}] * 27
        self.player.save()
        self.assertIsNone(async_to_sync(self.consumer.pick_up_arrow)(self.arrow_id))
        self.assertTrue(self.models.WorldArrow.objects.filter(arrow_id=self.arrow_id).exists())

    def test_leaf_decay_claim_and_persistent_pickup(self):
        from asgiref.sync import async_to_sync
        decay = async_to_sync(self.consumer.decay_leaf)
        pickup = async_to_sync(self.consumer.pick_up_drop)
        drop = decay(1, 5, 3, "apple", [1, 2.85, 3])
        self.assertEqual(drop["item_type"], "apple")
        self.assertIsNone(decay(1, 5, 3, "sapling", [1, 2.85, 3]))
        self.assertEqual(async_to_sync(self.consumer.load_drops)(), [drop])
        self.consumer.last_position = {"x": 50, "y": 2, "z": 3}
        self.assertIsNone(pickup(drop["drop_id"]))
        self.consumer.last_position = {"x": 1, "y": 2, "z": 3}
        self.player.inventory = [{"type": "stone", "color": "#777b82", "count": 64}] * 27
        self.player.save()
        self.assertIsNone(pickup(drop["drop_id"]))
        self.player.inventory = [None] * 27
        self.player.save()
        result = pickup(drop["drop_id"])
        self.assertEqual(result[0], {"type": "apple", "color": "#d83930", "count": 1})
        self.assertIsNone(pickup(drop["drop_id"]))
        self.player.refresh_from_db()
        self.assertEqual(self.player.inventory, result)

    def test_decay_does_not_remove_other_blocks(self):
        from asgiref.sync import async_to_sync
        self.models.WorldBlockEdit.objects.create(room="lobby", x=1, y=5, z=3,
                                                   color="#777b82")
        self.assertIsNone(async_to_sync(self.consumer.decay_leaf)(1, 5, 3, None, [1, 2, 3]))


if __name__ == "__main__":
    unittest.main()
