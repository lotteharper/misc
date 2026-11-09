# Voxel game deployment

The game uses `index.html` and `voxel-renderer.js` together with the Django
models and Channels consumer in `game_models.py` and `game_consumers.py`.
After adding the updated models to the Django application, generate and apply a
migration for its app label (`python manage.py makemigrations <app_label>` and
`python manage.py migrate`). The new `WorldDrop` table persists uncollected
saplings and apples; it must exist before deploying the updated consumer.

Leaf decay runs near active players. Unsupported leaves disappear gradually and
may leave a sapling or apple on the ground. Walk over an item to collect it;
apples can be eaten when health is below maximum.
