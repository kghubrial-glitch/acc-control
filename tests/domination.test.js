const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { EventEmitter } = require('node:events');
const Fleet = require('../lib/Fleet'),
  Actions = require('../lib/Actions'),
  Protocol = require('../lib/Protocol');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nulls-dom-'));
const clean = (root) => fs.rmSync(root, { recursive: true, force: true });
// Допустимые символы тега из utils/TagCodec + уникальная пара на индекс.
const TAG_CHARS = 'PYLQGRJCUV';
const TAG = (i) => '#' + TAG_CHARS[i % TAG_CHARS.length] + TAG_CHARS[Math.floor(i / TAG_CHARS.length) % TAG_CHARS.length];

function writeAccount(root, index) {
  fs.mkdirSync(path.join(root, 'accounts'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'accounts', `bot-${index}.json`),
    JSON.stringify({ passToken: 'token', hi: 0, lo: 1000 + index }),
  );
}

class FakeOnline extends EventEmitter {
  constructor(index) {
    super();
    this.index = index;
    this.state = 'online';
    this.club = null;
    this.attempts = 1;
    this.messaging = { send() {} };
  }
  close() {
    this.state = 'closed';
  }
  wait() {
    const promise = Promise.resolve().then(() => {
      this.club = { hi: 0, lo: this.index };
      return { type: 24399, payload: Buffer.alloc(0) };
    });
    return { promise, cancel() {}, item: { types: [] } };
  }
}

function setup(count, overrides = {}) {
  const root = tempRoot();
  const indexes = Array.from({ length: count }, (_, i) => i + 1);
  for (const index of indexes) writeAccount(root, index);
  const fleet = new Fleet(root, { indexes, commandLoginTimeout: 5000, ...overrides });
  for (const slot of fleet.slots) fleet.clients.set(slot.index, new FakeOnline(slot.index));
  return { root, fleet };
}

function stubActions(handler) {
  const original = Actions.execute;
  Actions.execute = async (client, action, args) => handler(client, action, args);
  return () => {
    Actions.execute = original;
  };
}

async function waitFor(fn, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (fn()) return;
    await sleep(20);
  }
  throw new Error('не дождались условия');
}

const DOM_STUBS = {
  'create-club': (client, action, args) => {
    const tag = TAG(client.index);
    const ref = Protocol.target(tag);
    client.club = { hi: ref.hi, lo: ref.lo, tag, name: args.clubName };
    return { confirmed: true, club: client.club };
  },
  'join-club': (client, action, args) => {
    const ref = Protocol.target(args.clubTag);
    client.club = { hi: ref.hi, lo: ref.lo, tag: args.clubTag };
    return { confirmed: true, club: client.club };
  },
  'leave-club': (client) => {
    client.club = null;
    return { confirmed: true };
  },
};

function setupDominationStubs(overrides = {}) {
  return stubActions(async (client, action, args) => {
    const custom = overrides[action];
    if (custom) return custom(client, action, args);
    const standard = DOM_STUBS[action];
    if (!standard) throw new Error('неожиданное действие ' + action);
    return standard(client, action, args);
  });
}

test('доминация: каждая группа — свой клуб, остальные вступают', async () => {
  const { root, fleet } = setup(6);
  const restore = setupDominationStubs();
  try {
    const snapshot = fleet.dominateClubs([1, 2, 3, 4, 5, 6], {
      dominateSize: 2,
      dominateJoinAttempts: 2,
      dominateJoinRetryMs: 100,
    });
    assert.equal(snapshot.planned, 3);
    await waitFor(() => fleet.domination && fleet.domination.state === 'done');
    const d = fleet.domination;
    assert.equal(d.clans.length, 3);
    assert.equal(d.clans.filter((clan) => clan.tag).length, 3);
    assert.equal(d.clans.reduce((n, clan) => n + clan.joined.length, 0), 6);
    assert.equal(d.clans.reduce((n, clan) => n + clan.failed.length, 0), 0);
    for (const clan of d.clans) {
      assert.equal(clan.state, 'done');
      assert.notEqual(clan.leaderIndex, null);
      assert.equal(clan.joined.length, 2, 'в каждой группе по 2 в клубе');
      assert.equal(clan.failed.length, 0);
      assert.match(clan.tag, /^#[PYLQGRJCUV]+$/);
    }
  } finally {
    restore();
    fleet.stop();
    clean(root);
  }
});

test('доминация: неполная последняя группа получает свой клуб', async () => {
  const { root, fleet } = setup(5);
  const restore = setupDominationStubs();
  try {
    fleet.dominateClubs([1, 2, 3, 4, 5], {
      dominateSize: 2,
      dominateJoinAttempts: 2,
      dominateJoinRetryMs: 100,
    });
    await waitFor(() => fleet.domination && fleet.domination.state === 'done');
    const d = fleet.domination;
    assert.equal(d.planned, 3, 'группы [1,2],[3,4],[5]');
    assert.equal(d.total, 5);
    assert.equal(
      d.clans.reduce((n, clan) => n + clan.joined.length, 0),
      5,
      'все пятеро в кланах (последний — только лидер)',
    );
    assert.equal(d.clans[2].members.length, 1);
    assert.equal(d.clans[2].joined.length, 1);
  } finally {
    restore();
    fleet.stop();
    clean(root);
  }
});

test('доминация: уже состоящего в клубе лидера выводим и создаём заново', async () => {
  const { root, fleet } = setup(3);
  for (const slot of fleet.slots) fleet.clients.get(slot.index).club = { hi: 9, lo: 9, tag: '#PP' };
  let left = 0;
  const remove = setupDominationStubs({
    'leave-club': (client) => {
      left++;
      client.club = null;
      return { confirmed: true };
    },
  });
  try {
    fleet.dominateClubs([1, 2, 3], {
      dominateSize: 3,
      dominateJoinAttempts: 2,
      dominateJoinRetryMs: 100,
    });
    await waitFor(() => fleet.domination && fleet.domination.state === 'done');
    const d = fleet.domination;
    assert.equal(d.clans.length, 1);
    assert.equal(left, 1, 'ровно один аккаунт вышел из прежнего клуба, чтобы создать новый');
    assert.equal(d.clans[0].joined.length, 3);
  } finally {
    remove();
    fleet.stop();
    clean(root);
  }
});

test('доминация: cancel останавливает активный прогон', async () => {
  const { root, fleet } = setup(4);
  const remove = stubActions(async (client, action, args) => {
    if (action === 'create-club') {
      const ref = Protocol.target(TAG(1));
      client.club = { hi: ref.hi, lo: ref.lo, tag: TAG(1), name: args.clubName };
      return { confirmed: true, club: client.club };
    }
    if (action === 'leave-club') {
      client.club = null;
      return {};
    }
    if (action === 'join-club') {
      await sleep(800);
      const ref = Protocol.target(args.clubTag);
      client.club = { hi: ref.hi, lo: ref.lo, tag: args.clubTag };
      return {};
    }
    throw new Error('неожиданное действие ' + action);
  });
  try {
    fleet.dominateClubs([1, 2, 3, 4], {
      dominateSize: 4,
      dominateJoinConcurrency: 1,
      dominateJoinAttempts: 3,
      dominateJoinRetryMs: 100,
    });
    await sleep(150);
    const snapshot = fleet.cancelDomination();
    assert.equal(snapshot.state, 'cancelled');
    await sleep(50);
    assert.equal(fleet.domination.state, 'cancelled', 'после отмены прогон не помечается done');
    fleet.dominateToken++;
  } finally {
    remove();
    fleet.stop();
    clean(root);
  }
});