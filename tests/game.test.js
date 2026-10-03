"use strict";

// Run with: node --test tests/
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SOURCE = fs.readFileSync(
  path.join(__dirname, "..", "game", "game.js"),
  "utf8",
);

function fakeElement() {
  const element = {
    style: { setProperty() {} },
    classList: { add() {}, remove() {}, toggle() {} },
    dataset: {},
    children: [],
    textContent: "",
    value: 0,
    appendChild(child) { this.children.push(child); },
    append(...c) { this.children.push(...c); },
    replaceChildren(...c) { this.children = [...c]; },
    addEventListener() {},
    getContext: () => new Proxy({}, { get: () => () => {} }),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1, height: 1 }),
    setPointerCapture() {},
    querySelectorAll: () => [],
  };
  return element;
}

// Loads the game script in a sandbox with a minimal DOM.
function loadGame() {
  const store = new Map();
  const sandbox = {
    console,
    performance: { now: () => 0 },
    Date,
    Math,
    URLSearchParams,
    WebSocket: class { static OPEN = 1; addEventListener() {} },
    requestAnimationFrame() {},
    navigator: { getGamepads: () => [] },
    document: {
      getElementById: () => fakeElement(),
      createElement: () => fakeElement(),
      querySelectorAll: () => [],
      addEventListener() {},
    },
    window: {
      location: { search: "", protocol: "http:", host: "localhost" },
      addEventListener() {},
      setTimeout: () => 0,
      clearTimeout() {},
      innerWidth: 800,
      innerHeight: 600,
      devicePixelRatio: 1,
      localStorage: {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
      },
    },
  };
  sandbox.window.window = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox);
  // Round-trip through JSON so results are plain objects of this realm.
  return (code) => {
    const value = vm.runInContext(code, sandbox);
    return value === undefined ? value : JSON.parse(JSON.stringify(value));
  };
}

const run = loadGame();

function fingerprint(r) {
  return r(`(() => {
    const out = [];
    for (let x = -20; x < 20; x++)
      for (let z = -20; z < 20; z++)
        for (let y = WORLD_MIN_Y; y < 8; y++) {
          const b = getBlock(x, y, z);
          out.push(b ? b.type : "air");
        }
    return out.join(",");
  })()`);
}

test("cave and ore generation is deterministic across reloads", () => {
  assert.equal(fingerprint(run), fingerprint(loadGame()));
});

test("world contains caves, coal, copper, iron and gold", () => {
  const stats = run(`(() => {
    const counts = {};
    let caves = 0, eligible = 0;
    for (let x = -60; x < 60; x++)
      for (let z = -60; z < 60; z++) {
        const h = terrainHeight(x, z);
        for (let y = WORLD_MIN_Y + 2; y <= h - CAVE_ROOF_THICKNESS; y++) {
          eligible++;
          const b = getBlock(x, y, z);
          if (!b) caves++;
          else if (ORE_BLOCKS[b.type]) counts[b.type] = (counts[b.type] || 0) + 1;
        }
      }
    return { counts, caves, eligible };
  })()`);
  for (const ore of ["coal_ore", "copper_ore", "iron_ore", "gold_ore"]) {
    assert.ok(stats.counts[ore] > 0, `missing ${ore}`);
  }
  const fraction = stats.caves / stats.eligible;
  assert.ok(fraction > 0.01 && fraction < 0.35, `cave fraction ${fraction}`);
});

test("caves stay below the surface roof and the world floor is solid", () => {
  const bad = run(`(() => {
    let n = 0;
    for (let x = -40; x < 40; x++)
      for (let z = -40; z < 40; z++) {
        const h = terrainHeight(x, z);
        if (!getBlock(x, WORLD_MIN_Y, z) && h > WORLD_MIN_Y) n++;
        for (let y = h - CAVE_ROOF_THICKNESS + 1; y < h; y++)
          if (y >= WORLD_MIN_Y && !getBlock(x, y, z)) n++;
      }
    return n;
  })()`);
  assert.equal(bad, 0);
});

test("edits override generated terrain", () => {
  run(`blockEdits.set(blockKey(0, -8, 0), null)`);
  assert.equal(run(`getBlock(0, -8, 0)`), null);
  run(`blockEdits.clear()`);
});

test("item and block colors are unique", () => {
  const colors = run(`[
    ...Object.values(ITEM_DEFINITIONS).map((d) => d.color),
    ...Object.values(ORE_BLOCKS).map((d) => d.color),
    ...Object.values(DOOR_BLOCK_COLORS).slice(1),
  ]`);
  assert.equal(new Set(colors).size, colors.length);
});

test("tier requirements are enforced and success yields ore", () => {
  const ok = (block, item) =>
    run(`canHarvest(${JSON.stringify(block)}, ${JSON.stringify(item)})`);
  const tool = (t) => ({ type: t, color: "#000000", count: 1 });

  assert.equal(ok({ type: "coal_ore" }, null), false);
  assert.equal(ok({ type: "coal_ore" }, tool("wood_axe")), false);
  assert.equal(ok({ type: "coal_ore" }, tool("wood_pickaxe")), true);
  assert.equal(ok({ type: "copper_ore" }, tool("wood_pickaxe")), false);
  assert.equal(ok({ type: "copper_ore" }, tool("stone_pickaxe")), true);
  assert.equal(ok({ type: "iron_ore" }, tool("stone_pickaxe")), false);
  assert.equal(ok({ type: "iron_ore" }, tool("copper_pickaxe")), true);
  assert.equal(ok({ type: "gold_ore" }, tool("copper_pickaxe")), false);
  assert.equal(ok({ type: "gold_ore" }, tool("iron_pickaxe")), true);
  assert.equal(ok({ type: "stone" }, null), true);
  assert.equal(ok({ type: "dirt" }, null), true);
});

test("better tools mine faster and requirement text names the tool", () => {
  const ms = (b, t) =>
    run(`miningDurationMs({type:"${b}"}, ${t ? `{type:"${t}",color:"#000000",count:1}` : "null"})`);

  assert.ok(ms("stone", "stone_pickaxe") < ms("stone", "wood_pickaxe"));
  assert.ok(ms("stone", "wood_pickaxe") < ms("stone", null));
  assert.ok(ms("log", "iron_axe") < ms("log", null));
  assert.equal(ms("stone", "iron_axe"), ms("stone", null));
  assert.equal(
    run(`requirementText({type:"gold_ore"})`),
    "Requires Iron Pickaxe or better",
  );
});

test("breaking ore drops the raw item only with a qualified tool", () => {
  const result = run(`(() => {
    inventory.fill(null);
    const coords = [3, -10, 3];
    blockEdits.set(blockKey(...coords), {x:3,y:-10,z:3,color:ORE_BLOCKS.iron_ore.color,type:"iron_ore"});
    selectedSlot = 0;
    const unqualified = canHarvest(getBlock(...coords), inventory[0]);
    const broke = breakBlockAt(...coords);
    blockEdits.clear();
    return { unqualified, broke, drop: inventory[0] && inventory[0].type };
  })()`);
  assert.equal(result.unqualified, false);
  assert.equal(result.broke, true);
  assert.equal(result.drop, "raw_iron");
});

test("items without a type migrate by color", () => {
  assert.equal(run(`resolveItemType({color:"#777b82",count:1})`), "stone");
  assert.equal(run(`resolveItemType({type:"bogus",color:"#e0773d",count:1})`), "copper_ingot");
  assert.equal(run(`resolveItemType({color:"#123456",count:1})`), "block:#123456");
});

test("furnace smelts with fuel, deterministically, and stops without fuel", () => {
  const r = run(`(() => {
    const f = createContainer("furnace");
    f.slots[0] = {type:"raw_copper",color:ITEM_DEFINITIONS.raw_copper.color,count:3};
    f.slots[1] = {type:"log",color:ITEM_DEFINITIONS.log.color,count:1};
    tickFurnace(f, SMELT_TIME_MS * 2);
    const afterTwo = { out: f.slots[2] && f.slots[2].count, input: f.slots[0].count, fuel: f.slots[1] && f.slots[1].count };
    tickFurnace(f, SMELT_TIME_MS * 10);
    return { afterTwo, out: f.slots[2].count, input: f.slots[0] && f.slots[0].count, outType: f.slots[2].type };
  })()`);
  assert.deepEqual(r.afterTwo, { out: 2, input: 1, fuel: null });
  // A log provides exactly two smelts, so the third needs more fuel.
  assert.equal(r.out, 2);
  assert.equal(r.input, 1);
  assert.equal(r.outType, "copper_ingot");

  const coal = run(`(() => {
    const f = createContainer("furnace");
    f.slots[0] = {type:"raw_iron",color:"#d3b8a4",count:8};
    f.slots[1] = {type:"coal",color:"#25262a",count:1};
    tickFurnace(f, SMELT_TIME_MS * 8 + 1);
    return [f.slots[2].count, f.slots[0], f.slots[1]];
  })()`);
  assert.deepEqual(coal, [8, null, null]);
});

test("furnace only accepts ore as input and fuel as fuel", () => {
  const r = run(`(() => {
    const f = createContainer("furnace");
    const it = (type) => ({type, color: ITEM_DEFINITIONS[type].color, count: 1});
    return [
      containerAccepts(f, 0, it("raw_gold")),
      containerAccepts(f, 0, it("stone")),
      containerAccepts(f, 1, it("coal")),
      containerAccepts(f, 1, it("log")),
      containerAccepts(f, 1, it("raw_gold")),
      containerAccepts(f, 2, it("copper_ingot")),
    ];
  })()`);
  assert.deepEqual(r, [true, false, true, true, false, false]);
});

test("furnace output collection never loses items when inventory is full", () => {
  const r = run(`(() => {
    inventory.fill(null);
    for (let i = 0; i < 27; i++) inventory[i] = {type:"stone",color:ITEM_DEFINITIONS.stone.color,count:64};
    blockEdits.set(blockKey(5,0,5), {x:5,y:0,z:5,color:ITEM_DEFINITIONS.furnace.color,type:"furnace"});
    openContainerAt(5,0,5);
    const f = getOpenContainer();
    f.slots[2] = {type:"iron_ingot",color:ITEM_DEFINITIONS.iron_ingot.color,count:5};
    moveContainerToInventory(2);
    const stuck = f.slots[2] && f.slots[2].count;
    inventory[0] = null;
    moveContainerToInventory(2);
    const result = { stuck, left: f.slots[2], got: inventory[0] };
    closeContainer(); blockEdits.clear(); containers.clear(); inventory.fill(null);
    return result;
  })()`);
  assert.equal(r.stuck, 5);
  assert.equal(r.left, null);
  assert.equal(r.got.type, "iron_ingot");
  assert.equal(r.got.count, 5);
});

test("chest stack transfers conserve item counts", () => {
  const r = run(`(() => {
    inventory.fill(null);
    inventory[0] = {type:"stone",color:ITEM_DEFINITIONS.stone.color,count:60};
    inventory[1] = {type:"stone",color:ITEM_DEFINITIONS.stone.color,count:30};
    inventory[2] = {type:"log",color:ITEM_DEFINITIONS.log.color,count:7};
    blockEdits.set(blockKey(9,0,9), {x:9,y:0,z:9,color:ITEM_DEFINITIONS.chest.color,type:"chest"});
    openContainerAt(9,0,9);
    const chest = getOpenContainer();
    const total = (items, t) => items.reduce((n, i) => n + (i && i.type === t ? i.count : 0), 0);
    moveInventoryToContainer(0);
    moveInventoryToContainer(1);
    moveInventoryToContainer(2);
    const stored = { stone: total(chest.slots, "stone"), log: total(chest.slots, "log"), inv: inventory.filter(Boolean).length };
    moveContainerToInventory(0);
    const back = total(inventory, "stone") + total(chest.slots, "stone");
    // drag a stack onto a specific slot, swapping with a different stack
    chest.slots[5] = {type:"log",color:ITEM_DEFINITIONS.log.color,count:2};
    inventory[3] = {type:"stone",color:ITEM_DEFINITIONS.stone.color,count:4};
    dropOnContainerSlot("3", 5);
    const swapped = [chest.slots[5].type, inventory[3].type];
    const all = total(inventory, "stone") + total(chest.slots, "stone");
    closeContainer(); blockEdits.clear(); containers.clear(); inventory.fill(null);
    return { stored, back, swapped, all };
  })()`);
  assert.deepEqual(r.stored, { stone: 90, log: 7, inv: 0 });
  assert.equal(r.back, 90);
  assert.deepEqual(r.swapped, ["stone", "log"]);
  assert.equal(r.all, 94);
});

test("non-empty containers cannot be broken and persist locally", () => {
  const r = run(`(() => {
    inventory.fill(null);
    blockEdits.set(blockKey(2,0,2), {x:2,y:0,z:2,color:ITEM_DEFINITIONS.chest.color,type:"chest"});
    const c = ensureContainer(2,0,2,"chest");
    c.slots[0] = {type:"coal",color:ITEM_DEFINITIONS.coal.color,count:3};
    const refused = breakBlockAt(2,0,2) === false;
    saveContainers();
    containers.clear();
    loadContainers();
    const restored = containers.get(blockKey(2,0,2)).slots[0];
    containers.get(blockKey(2,0,2)).slots[0] = null;
    const broke = breakBlockAt(2,0,2);
    const drop = inventory[0] && inventory[0].type;
    blockEdits.clear(); containers.clear(); inventory.fill(null);
    return { refused, restored, broke, drop };
  })()`);
  assert.equal(r.refused, true);
  assert.equal(r.restored.type, "coal");
  assert.equal(r.restored.count, 3);
  assert.equal(r.broke, true);
  assert.equal(r.drop, "chest");
});

function craft(id, inv) {
  return run(`(() => {
    inventory.fill(null);
    ${Object.entries(inv).map(([t, c], i) => `inventory[${i}] = {type:"${t}",color:ITEM_DEFINITIONS["${t}"].color,count:${c}};`).join("\n")}
    craftRecipe(CRAFTING_RECIPES.find((r) => r.id === "${id}"));
    const counts = {};
    for (const i of inventory) if (i) counts[i.type] = (counts[i.type] || 0) + i.count;
    inventory.fill(null);
    return counts;
  })()`);
}

test("existing and new crafting recipes work", () => {
  assert.deepEqual(craft("planks", { log: 1 }), { planks: 4 });
  assert.deepEqual(craft("door", { planks: 6 }), { door: 3 });
  assert.deepEqual(craft("furnace", { stone: 8 }), { furnace: 1 });
  assert.deepEqual(craft("chest", { planks: 8 }), { chest: 1 });
  assert.deepEqual(
    craft("iron_pickaxe", { iron_ingot: 3, sticks: 2 }),
    { iron_pickaxe: 1 },
  );
  // Not enough materials leaves the inventory unchanged.
  assert.deepEqual(craft("furnace", { stone: 7 }), { stone: 7 });
});

test("crafting rolls back when the inventory is full", () => {
  const r = run(`(() => {
    inventory.fill(null);
    for (let i = 0; i < 27; i++) inventory[i] = {type:"dirt",color:ITEM_DEFINITIONS.dirt.color,count:64};
    inventory[0] = {type:"log",color:ITEM_DEFINITIONS.log.color,count:64};
    inventory[1] = {type:"planks",color:ITEM_DEFINITIONS.planks.color,count:64};
    craftRecipe(CRAFTING_RECIPES.find((r) => r.id === "planks"));
    const logs = inventory[0].count;
    inventory.fill(null);
    return logs;
  })()`);
  assert.equal(r, 64);
});

test("player can step up one block but not two", () => {
  const r = run(`(() => {
    blockEdits.clear(); placedBlocks.clear();
    // Flat test area: a floor at y=100 with a step further along +x.
    const set = (x, y, z) => blockEdits.set(blockKey(x,y,z), {x,y,z,color:"#777b82",type:"stone"});
    for (let x = -2; x < 8; x++) for (let z = -2; z < 3; z++) set(x, 99, z);
    for (let x = 3; x < 8; x++) for (let z = -2; z < 3; z++) set(x, 100, z);
    for (let x = 6; x < 8; x++) for (let z = -2; z < 3; z++) { set(x, 101, z); set(x, 102, z); }
    camera.pos = [0.5, 100, 0.5];
    camera.grounded = true;
    for (let i = 0; i < 400 && camera.pos[0] < 5; i++) tryHorizontalMove(0.05, 0);
    const climbed = camera.pos[1];
    const x1 = camera.pos[0];
    // x=6 starts a 2-block-high wall above the raised floor.
    for (let i = 0; i < 200; i++) tryHorizontalMove(0.05, 0);
    const result = { climbed, blocked: camera.pos[0] < 6 };
    blockEdits.clear();
    return result;
  })()`);
  assert.equal(r.climbed, 101);
  assert.equal(r.blocked, true);
});
