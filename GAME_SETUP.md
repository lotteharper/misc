# Voxel game deployment

The game uses `index.html` and `voxel-renderer.js` together with the Django
models and Channels consumer in `game_models.py` and `game_consumers.py`.
After adding the updated models to the Django application, generate and apply a
migration for its app label (`python manage.py makemigrations <app_label>` and
`python manage.py migrate`). The new `WorldDrop` table persists uncollected
saplings and apples; it must exist before deploying the updated consumer.

Nearby players display their authenticated usernames above their avatars within
16 blocks. Their bodies turn with their view direction, and their heads tilt as
they look up or down. The consumer supplies names and orientation to both
existing and joining players.

Leaf decay runs near active players. Unsupported leaves disappear gradually and
drop saplings and apples as they decay. An intact tree canopy yields at least
three saplings and apples; drops fall from the leaves and remain on the ground
until collected. Saplings, apples, and landed arrows within five blocks move
toward the player and are collected when there is room in the inventory;
apples can be eaten when health is below maximum.

Wood planks and stone can be crafted into slabs and stairs. Stairs rise in the
direction the player faces when placing them and form outer corners when they
meet perpendicular stairs. Slabs and stair steps can be walked up and down
without jumping.
