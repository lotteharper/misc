const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync("threethirteen.js", "utf8");

function createClient(player) {
  const stages = [];
  const sockets = [];

  class DisplayObject {
    constructor() {
      this.mouseEnabled = true;
      this.listeners = {};
    }

    on(type, handler) {
      this.listeners[type] = handler;
    }
  }

  class Container extends DisplayObject {
    constructor() {
      super();
      this.children = [];
    }

    addChild(...children) {
      this.children.push(...children);
    }

    removeChild(child) {
      this.children.splice(this.children.indexOf(child), 1);
    }

    contains(child) {
      return this.children.includes(child);
    }
  }

  class Stage extends Container {
    constructor() {
      super();
      stages.push(this);
    }

    update() {}
  }

  class Shape extends DisplayObject {
    constructor() {
      super();
      this.graphics = new Proxy({}, {
        get: () => () => this.graphics,
      });
    }
  }

  class Text extends DisplayObject {
    constructor(text) {
      super();
      this.text = text;
    }
  }

  class Bitmap extends DisplayObject {
    constructor(image) {
      super();
      this.image = image;
    }
  }

  class Image {
    set src(value) {
      this.url = value;
      queueMicrotask(() => this.onload());
    }
  }

  class WebSocket {
    static OPEN = 1;

    constructor() {
      this.readyState = WebSocket.OPEN;
      this.listeners = {};
      this.sent = [];
      sockets.push(this);
    }

    addEventListener(type, handler) {
      this.listeners[type] = handler;
    }

    send(message) {
      this.sent.push(message);
    }

    receive(message) {
      this.listeners.message({ data: JSON.stringify(message) });
    }
  }

  const elements = {
    post_id: { innerHTML: "1" },
    game_code: { innerHTML: "code" },
    game_id: { innerHTML: "42" },
    player: { innerHTML: player === "Player 1" ? "y" : "n" },
    dontshowad: { innerHTML: "true" },
    game: {},
  };
  const context = {
    document: { getElementById: (id) => elements[id] },
    window: {
      innerWidth: 1000,
      innerHeight: 1000,
      location: { hostname: "localhost" },
      addEventListener() {},
    },
    createjs: {
      Stage, Container, Shape, Text, Bitmap,
      Ticker: { addEventListener() {} },
    },
    Image, WebSocket, setTimeout, clearTimeout, console,
  };
  vm.runInNewContext(source, context);

  function find(predicate) {
    function search(node, enabled) {
      const active = enabled && node.mouseEnabled !== false;
      if (predicate(node)) {
        return { node, active };
      }
      for (const child of node.children || []) {
        const found = search(child, active);
        if (found) return found;
      }
      return null;
    }
    return search(stages[0], true);
  }

  function click(predicate) {
    const found = find(predicate);
    assert.ok(found, "click target exists");
    assert.ok(found.active, "click target and its ancestors accept mouse input");
    assert.ok(found.node.listeners.mousedown, "click target has a handler");
    found.node.listeners.mousedown({ currentTarget: found.node });
  }

  return {
    socket: () => sockets[0],
    find,
    click,
    button: () => find((node) =>
      node.children && node.children.some((child) =>
        child.text === "Advance to next round" || child.text === "Finish game"
      )
    ),
    round: () => find((node) => node instanceof Text && node.textAlign === "center" &&
      node.x === 500 && node.y === 470),
  };
}

async function setup() {
  const first = createClient("Player 1");
  const second = createClient("Player 2");
  await new Promise((resolve) => setImmediate(resolve));
  for (const client of [first, second]) {
    client.socket().receive({ type: "game_state", game_id: 42, history: [] });
  }
  return [first, second];
}

function action(client, value) {
  client.socket().receive({ type: "game_action", action: value });
}

function finalTurn(loser, winner, round = 3) {
  loser.click((node) => node instanceof Object && node.image &&
    node.image.url.endsWith("/back.png") && node.x === 187.5 && node.y === 342.5);
  assert.equal(loser.socket().sent.at(-1), "draw,deck,Player 2/");
  action(winner, "draw,deck,Player 2");
  loser.click((node) => node.cardValue !== undefined && node.cardValue !== round - 1);
  const discard = loser.socket().sent.at(-1).slice(0, -1);
  assert.match(discard, /^discard,\d+\.\d+,Player 2$/);
  action(winner, discard);
  return ["draw,deck,Player 2", discard];
}

test("settlement button waits for the final turn and server confirmation", async () => {
  const [winner, loser] = await setup();
  for (const client of [winner, loser]) action(client, "round_complete,3,Player 1");
  assert.equal(winner.button().node.enabled, false);
  assert.equal(loser.button().node.enabled, false);
  finalTurn(loser, winner);
  assert.equal(winner.button().node.enabled, true);
  assert.equal(loser.button().node.enabled, true);
  winner.click((node) => node === winner.button().node);
  assert.equal(winner.socket().sent.at(-1), "round_advance,3,Player 1/");
  assert.equal(winner.round().node.text, "3");
  assert.equal(winner.button().node.enabled, false);
  for (const client of [winner, loser]) action(client, "round_advance,3,Player 1");
  assert.equal(winner.round().node.text, "4");
  assert.equal(loser.round().node.text, "4");
  assert.equal(winner.button(), null);
});

test("a rejected advance can be retried and a reconnect replays settlement", async () => {
  const [winner, loser] = await setup();
  for (const client of [winner, loser]) action(client, "round_complete,3,Player 1");
  const finalActions = finalTurn(loser, winner);
  winner.click((node) => node === winner.button().node);
  winner.socket().receive({ type: "game_action_error", action: "round_advance,3,Player 1" });
  assert.equal(winner.button().node.enabled, true);
  winner.click((node) => node === winner.button().node);
  winner.socket().receive({
    type: "game_state",
    game_id: 42,
    history: ["round_complete,3,Player 1", ...finalActions],
  });
  assert.equal(winner.button().node.enabled, true);
  winner.click((node) => node === winner.button().node);
  action(winner, "round_advance,3,Player 2");
  assert.equal(winner.round().node.text, "4");
});

test("all rounds, including the final round, replay with consistent scores", async () => {
  const [winner, loser] = await setup();
  const history = [];
  for (let round = 3; round <= 13; round++) {
    const complete = `round_complete,${round},Player 1`;
    history.push(complete);
    for (const client of [winner, loser]) action(client, complete);
    history.push(...finalTurn(loser, winner, round));
    const advance = `round_advance,${round},Player 2`;
    loser.click((node) => node === loser.button().node);
    assert.equal(loser.socket().sent.at(-1), advance + "/");
    history.push(advance);
    for (const client of [winner, loser]) action(client, advance);
  }
  assert.ok(winner.find((node) => node.text === "Game complete"));
  assert.ok(loser.find((node) => node.text === "Game complete"));
  const scores = (client) => [
    client.find((node) => node.x === 50 && node.y === 580).node.text,
    client.find((node) => node.x === 50 && node.y === 380).node.text,
  ];
  assert.deepEqual(scores(winner), scores(loser).reverse());
  const before = scores(winner);
  winner.socket().receive({ type: "game_state", game_id: 42, history });
  assert.deepEqual(scores(winner), before);
  assert.ok(winner.find((node) => node.text === "Game complete"));
});
