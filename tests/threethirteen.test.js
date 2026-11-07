const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync("threethirteen.js", "utf8");

function createClient(player, location = { protocol: "https:", host: "localhost" }) {
  const stages = [];
  const sockets = [];
  let reconnect;

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
      for (const child of children) {
        const index = this.children.indexOf(child);
        if (index >= 0) this.children.splice(index, 1);
      }
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

    constructor(url) {
      this.url = url;
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

    close() {
      this.readyState = 3;
      this.listeners.close();
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
      location,
      addEventListener() {},
    },
    createjs: {
      Stage, Container, Shape, Text, Bitmap,
      Ticker: { addEventListener() {} },
    },
    Image, WebSocket,
    setTimeout: (callback) => { reconnect = callback; return 1; },
    clearTimeout: () => { reconnect = null; },
    console,
  };
  const instrumentedSource = source.replace(/\}\)\(\);\s*$/, `
    globalThis.testGame = {
      Card, calculateScore, sortCardsByMeld,
      setOpponentCards(cards, round) {
        opponentCards = cards;
        currentRound = round;
        drawOpponentHand(false);
      },
      opponentCards: () => opponentCards,
      playerCards: () => playerCards,
      opponentObjects: () => opponentObjects
    };
  })();`);
  vm.runInNewContext(instrumentedSource, context);

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
    game: context.testGame,
    socket: () => sockets.at(-1),
    reconnect: () => reconnect(),
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

function cardLabels(cards) {
  return Array.from(cards, (card) => `${card.getValue()}.${card.getSuit()}`);
}

test("meld ordering uses the scoring hand without changing cards or score", () => {
  const { game } = createClient("Player 1");
  const cards = [
    new game.Card(8, 1), new game.Card(1, 2), new game.Card(5, 0),
    new game.Card(8, 0), new game.Card(6, 1), new game.Card(3, 0),
    new game.Card(8, 3), new game.Card(9, 3),
  ];
  const original = cardLabels(cards);
  const score = game.calculateScore(cards, 7);
  const sorted = game.sortCardsByMeld(cards, 7);

  assert.deepEqual(cardLabels(sorted), [
    "3.0", "6.1", "5.0", "8.0", "8.1", "8.3", "1.2", "9.3",
  ]);
  assert.equal(score, 12);
  assert.equal(game.calculateScore(sorted, 7), score);
  assert.deepEqual(cardLabels(cards), original);
  assert.equal(new Set(sorted).size, cards.length);
});

test("WebSocket URL uses the page's scheme and host, including its port", async () => {
  const secure = createClient("Player 1", { protocol: "https:", host: "example.com:8443" });
  const local = createClient("Player 2", { protocol: "http:", host: "localhost:8000" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(secure.socket().url, "wss://example.com:8443/ws/games/1/code/?player=Player%201");
  assert.equal(local.socket().url, "ws://localhost:8000/ws/games/1/code/?player=Player%202");
});

test("meld ordering handles sets with wildcards, duplicates, high aces and wild-only melds", () => {
  const { game } = createClient("Player 1");
  const makeCards = (labels) => labels.map(([value, suit]) => new game.Card(value, suit));
  const cases = [
    {
      round: 5,
      cards: [[9, 3], [8, 0], [4, 2], [8, 0], [1, 1]],
      expected: ["8.0", "8.0", "4.2", "9.3", "1.1"],
    },
    {
      round: 5,
      cards: [[0, 0], [11, 0], [4, 1], [1, 3]],
      expected: ["11.0", "4.1", "0.0", "1.3"],
    },
    {
      round: 5,
      cards: [[4, 2], [4, 0], [4, 3]],
      expected: ["4.2", "4.0", "4.3"],
    },
    {
      round: 5,
      cards: [[1, 3], [8, 0], [4, 2]],
      expected: ["1.3", "8.0", "4.2"],
    },
  ];
  for (const { round, cards: values, expected } of cases) {
    const cards = makeCards(values);
    const score = game.calculateScore(cards, round);
    const sorted = game.sortCardsByMeld(cards, round);
    assert.deepEqual(cardLabels(sorted), expected);
    assert.equal(game.calculateScore(sorted, round), score);
    assert.deepEqual(cardLabels(cards), values.map(([value, suit]) => `${value}.${suit}`));
  }
});

test("revealed opponent hand is redrawn in meld order during settlement", async () => {
  const [client] = await setup();
  const { game } = client;
  const cards = [
    new game.Card(8, 1), new game.Card(1, 2), new game.Card(5, 0),
    new game.Card(8, 0), new game.Card(6, 1), new game.Card(3, 0),
    new game.Card(8, 3),
  ];
  game.setOpponentCards(cards, 7);
  assert.ok(Array.from(game.opponentObjects()).every((bitmap) => bitmap.image.url.endsWith("/back.png")));

  action(client, "round_complete,7,Player 1");
  const shown = () => Array.from(game.opponentObjects())
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((bitmap) => bitmap.image.url.split("/").pop());
  assert.deepEqual(shown(), ["4S.png", "7H.png", "6S.png", "9S.png", "9H.png", "9D.png", "2C.png"]);
  assert.deepEqual(cardLabels(game.opponentCards()), cardLabels(cards));

  action(client, "draw,deck,Player 2");
  assert.equal(game.opponentObjects().length, 8);
  action(client, "discard,1.2,Player 2");
  assert.deepEqual(shown(), ["4S.png", "7H.png", "6S.png", "9S.png", "9H.png", "9D.png", "QC.png"]);
  assert.deepEqual(cardLabels(game.opponentCards()), ["8.1", "5.0", "8.0", "6.1", "3.0", "8.3", "11.2"]);
});

async function setup() {
  const first = createClient("Player 1");
  const second = createClient("Player 2");
  await new Promise((resolve) => setImmediate(resolve));
  for (const client of [first, second]) {
    client.socket().receive({ type: "game_state", game_id: 42, history: [], players_connected: true });
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
  action(loser, "draw,deck,Player 2");
  action(winner, "draw,deck,Player 2");
  loser.click((node) => node.cardValue !== undefined && node.cardValue !== round - 1);
  const discard = loser.socket().sent.at(-1).slice(0, -1);
  assert.match(discard, /^discard,\d+\.\d+,Player 2$/);
  action(loser, discard);
  action(winner, discard);
  return ["draw,deck,Player 2", discard];
}

test("both players must confirm before either client advances", async () => {
  const [winner, loser] = await setup();
  for (const client of [winner, loser]) action(client, "round_complete,3,Player 1");
  assert.equal(winner.button().node.enabled, false);
  assert.equal(loser.button().node.enabled, false);
  finalTurn(loser, winner);
  assert.equal(winner.button().node.enabled, true);
  assert.equal(loser.button().node.enabled, true);
  winner.click((node) => node === winner.button().node);
  assert.equal(winner.socket().sent.at(-1), "round_ready,3,Player 1/");
  assert.equal(winner.round().node.text, "3");
  assert.equal(winner.button().node.enabled, false);
  for (const client of [winner, loser]) action(client, "round_ready,3,Player 1");
  assert.equal(loser.round().node.text, "3");
  assert.equal(loser.button().node.enabled, true);
  assert.ok(winner.find((node) => node.text === "Waiting for the other player"));
  assert.ok(loser.find((node) => node.text === "Other player is ready"));
  loser.click((node) => node === loser.button().node);
  assert.equal(loser.socket().sent.at(-1), "round_ready,3,Player 2/");
  assert.equal(loser.round().node.text, "3");
  for (const client of [winner, loser]) action(client, "round_ready,3,Player 2");
  for (const client of [winner, loser]) action(client, "round_advance,3,Player 2");
  assert.equal(winner.round().node.text, "4");
  assert.equal(loser.round().node.text, "4");
  assert.equal(winner.button(), null);
});

test("a rejected advance can be retried and a reconnect replays settlement", async () => {
  const [winner, loser] = await setup();
  for (const client of [winner, loser]) action(client, "round_complete,3,Player 1");
  const finalActions = finalTurn(loser, winner);
  winner.click((node) => node === winner.button().node);
  winner.socket().receive({
    type: "game_action_error", action: "round_ready,3,Player 1",
    state: { type: "game_state", game_id: 42, players_connected: true,
      history: ["round_complete,3,Player 1", ...finalActions] },
  });
  assert.equal(winner.button().node.enabled, true);
  winner.click((node) => node === winner.button().node);
  winner.socket().receive({
    type: "game_state",
    game_id: 42,
    players_connected: true,
    history: ["round_complete,3,Player 1", ...finalActions],
  });
  assert.equal(winner.button().node.enabled, true);
  winner.click((node) => node === winner.button().node);
  action(winner, "round_ready,3,Player 1");
  winner.socket().receive({
    type: "game_state",
    game_id: 42,
    players_connected: true,
    history: ["round_complete,3,Player 1", ...finalActions, "round_ready,3,Player 1"],
  });
  assert.equal(winner.button().node.enabled, false);
  assert.ok(winner.find((node) => node.text === "Waiting for the other player"));
  action(winner, "round_ready,3,Player 2");
  assert.equal(winner.round().node.text, "3");
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
    const firstReady = `round_ready,${round},Player 2`;
    const secondReady = `round_ready,${round},Player 1`;
    const advance = `round_advance,${round},Player 1`;
    loser.click((node) => node === loser.button().node);
    assert.equal(loser.socket().sent.at(-1), firstReady + "/");
    for (const client of [winner, loser]) action(client, firstReady);
    winner.click((node) => node === winner.button().node);
    assert.equal(winner.socket().sent.at(-1), secondReady + "/");
    for (const client of [winner, loser]) action(client, secondReady);
    const roundLabel = { 11: "J", 12: "Q", 13: "K" }[round] || String(round);
    assert.equal(winner.round().node.text, roundLabel);
    assert.equal(loser.round().node.text, roundLabel);
    history.push(firstReady, secondReady, advance);
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
  winner.socket().receive({ type: "game_state", game_id: 42, history, players_connected: true });
  assert.deepEqual(scores(winner), before);
  assert.ok(winner.find((node) => node.text === "Game complete"));
});

test("legacy round advances remain replayable", async () => {
  const [winner, loser] = await setup();
  for (const client of [winner, loser]) action(client, "round_complete,3,Player 1");
  const finalActions = finalTurn(loser, winner);
  winner.socket().receive({
    type: "game_state",
    game_id: 42,
    players_connected: true,
    history: ["round_complete,3,Player 1", ...finalActions, "round_advance,3,Player 1"],
  });
  assert.equal(winner.round().node.text, "4");
});

test("moves wait for both players and for server confirmation", async () => {
  const client = createClient("Player 1");
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(client.socket().url, /player=Player%201$/);
  const deck = () => client.click((node) => node.image &&
    node.image.url.endsWith("/back.png") && node.x === 187.5 && node.y === 342.5);
  client.socket().receive({ type: "game_state", game_id: 42, history: [], players_connected: false });
  assert.ok(client.find((node) => node.text === "Waiting for both players to connect"));
  const container = client.find((node) => node.children && node.children.some((child) =>
    child.text === "Waiting for both players to connect")).node;
  assert.equal(container.children.at(-1).text, "Waiting for both players to connect");
  deck();
  assert.equal(client.socket().sent.length, 0);
  assert.equal(client.game.playerCards().length, 3);

  client.socket().receive({ type: "game_presence", players_connected: true });
  deck();
  assert.deepEqual(client.socket().sent, ["draw,deck,Player 1/"]);
  assert.equal(client.game.playerCards().length, 3);
  deck();
  assert.equal(client.socket().sent.length, 1);
  action(client, "draw,deck,Player 1");
  assert.equal(client.game.playerCards().length, 4);

  client.socket().receive({ type: "game_presence", players_connected: false });
  client.click((node) => node.cardValue !== undefined && node.cardValue !== 2);
  assert.equal(client.socket().sent.length, 1);
  assert.equal(client.game.playerCards().length, 4);
  client.socket().receive({ type: "game_presence", players_connected: true });
  client.click((node) => node.cardValue !== undefined && node.cardValue !== 2);
  assert.match(client.socket().sent.at(-1), /^discard,/);
  assert.equal(client.game.playerCards().length, 4);
});

test("rejected and disconnected moves recover from authoritative history", async () => {
  const [client] = await setup();
  const deck = () => client.click((node) => node.image &&
    node.image.url.endsWith("/back.png") && node.x === 187.5 && node.y === 342.5);
  deck();
  client.socket().receive({
    type: "game_action_error", action: "draw,deck,Player 1",
    state: { type: "game_state", game_id: 42, history: [], players_connected: false },
  });
  assert.equal(client.game.playerCards().length, 3);
  deck();
  assert.equal(client.socket().sent.length, 1);

  client.socket().receive({ type: "game_presence", players_connected: true });
  deck();
  client.socket().close();
  deck();
  assert.equal(client.socket().sent.length, 2);
  client.reconnect();
  client.socket().receive({
    type: "game_state", game_id: 42,
    history: ["draw,deck,Player 1"], players_connected: true,
  });
  assert.equal(client.game.playerCards().length, 4);
  client.click((node) => node.cardValue !== undefined && node.cardValue !== 2);
  assert.match(client.socket().sent.at(-1), /^discard,/);
});

test("the second player cannot draw from either pile without the opponent", async () => {
  const [first, second] = await setup();
  first.click((node) => node.image &&
    node.image.url.endsWith("/back.png") && node.x === 187.5 && node.y === 342.5);
  action(first, "draw,deck,Player 1");
  first.click((node) => node.cardValue !== undefined && node.cardValue !== 2);
  const discard = first.socket().sent.at(-1).slice(0, -1);
  second.socket().receive({
    type: "game_state", game_id: 42, players_connected: false,
    history: ["draw,deck,Player 1", discard],
  });
  const deck = () => second.click((node) => node.image &&
    node.image.url.endsWith("/back.png") && node.x === 187.5 && node.y === 342.5);
  const discardPile = () => second.click((node) => node.image &&
    !node.image.url.endsWith("/back.png") && node.x === 587.5 && node.y === 342.5);

  deck();
  discardPile();
  assert.equal(second.socket().sent.length, 0);
  second.socket().receive({ type: "game_presence", players_connected: true });
  discardPile();
  assert.equal(second.socket().sent.at(-1), "draw,discard,Player 2/");
});

test("replaying a completed turn preserves whose turn is next", async () => {
  const [first, second] = await setup();
  const deck = (client) => client.click((node) => node.image &&
    node.image.url.endsWith("/back.png") && node.x === 187.5 && node.y === 342.5);
  deck(first);
  action(first, "draw,deck,Player 1");
  first.click((node) => node.cardValue !== undefined && node.cardValue !== 2);
  const discard = first.socket().sent.at(-1).slice(0, -1);
  const history = ["draw,deck,Player 1", discard];
  for (const client of [first, second]) {
    client.socket().receive({ type: "game_state", game_id: 42, history, players_connected: true });
  }
  const firstCount = first.socket().sent.length;
  deck(first);
  assert.equal(first.socket().sent.length, firstCount);
  deck(second);
  assert.equal(second.socket().sent.at(-1), "draw,deck,Player 2/");
});
