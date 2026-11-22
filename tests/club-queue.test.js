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
const tempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nulls-club-'));
const clean = (root) => fs.rmSync(root, { recursive: true, force: true });
const CLUB = '#2Y0L8Q';
const clubRef = () => Protocol.target(CLUB);

function writeAccount(root, index) {
  fs.mkdirSync(path.join(root, 'accounts'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'accounts', `bot-${index}.json`),
    JSON.stringify({ passToken: 'token', hi: 0, lo: 100 + index }),
  );
}

class FakeOnline extends EventEmitter {
  constructor(index) {
    super();
    this.index = index;
    this.state = 'online';
    this.club = null;
    this.attempts = 1;
    this.joinRefuses = false;
    this.messaging = { send() {} };
  }
  close() {
    this.state = 'closed';
  }
  wait() {
    const promise = Promise.resolve().then(() => {
      if (this.joinRefuses) throw new Error('клуб заполнен');
      this.club = clubRef();
      return { type: 24399, payload: Buffer.alloc(0) };
    });
    return { promise, cancel() {}, item: { types: [] } };
  }
}

function setup(overrides = {}) {
  const root = tempRoot();
  for (const index of [1, 2, 3]) writeAccount(root, index);
  const fleet = new Fleet(root, {
    indexes: [1, 2, 3],
    clubTag: CLUB,
    clubFill: true,
    clubFillCheckMs: 500,
    clubFillRetryMs: 100,
    clubFillConcurrency: 3,
    ...overrides,
  });
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

test('явный набор индексов создаёт слоты только для этих ботов', () => {
  const root = tempRoot();
  try {
    const fleet = new Fleet(root, { indexes: [2, 5, 9] });
    assert.deepEqual(fleet.slots.map((s) => s.index), [2, 5, 9]);
    assert.equal(fleet.first, 2);
    assert.equal(fleet.count, 3);
    assert.deepEqual(fleet.resolveIndexes({ select: '5,9' }), [5, 9]);
    assert.deepEqual(fleet.resolveIndexes({ select: 'all' }), [2, 5, 9]);
  } finally {
    clean(root);
  }
});

test('полный клуб: боты ждут в очереди, заявки не отправляются', async () => {
  const { root, fleet } = setup();
  let joins = 0;
  const restore = stubActions(async (client, action) => {
    if (action === 'club-info') return { full: true, memberCount: 50, members: [] };
    if (action === 'join-club') {
      joins++;
      client.club = clubRef();
      return { confirmed: true };
    }
    return {};
  });
  try {
    const result = fleet.wantClub([1, 2, 3]);
    assert.equal(result.queued, 3);
    await sleep(50);
    assert.equal(joins, 0, 'в полный клуб заявки не уходят');
    assert.deepEqual(fleet.slots.map((s) => s.clubState), ['want', 'want', 'want']);
    assert.equal(fleet.clubQueueSnapshot().want, 3);
    assert.equal(fleet.clubQueueSnapshot().full, true);
  } finally {
    restore();
    fleet.stop();
    clean(root);
  }
});

test('освободилось место — очередь вступает, лишние ждут следующей попытки', async () => {
  const { root, fleet } = setup({ clubFillConcurrency: 2 });
  const restore = stubActions(async (client, action) => {
    if (action === 'club-info') return { full: false, memberCount: 10, members: [] };
    return {};
  });
  try {
    fleet.wantClub([1, 2, 3]);
    await sleep(80);
    assert.deepEqual(
      fleet.slots.map((s) => s.clubState),
      ['joined', 'joined', 'want'],
      'за одну волну — не больше concurrency, третий ждёт',
    );
    // Следующая волна добирает третьего.
    await fleet.pumpClub();
    assert.equal(fleet.slots.find((s) => s.index === 3).clubState, 'joined');
  } finally {
    restore();
    fleet.stop();
    clean(root);
  }
});

test('выкинутый из клуба бот возвращается в очередь', async () => {
  const { root, fleet } = setup();
  const restore = stubActions(async (client, action) => {
    if (action === 'club-info') return { full: false, memberCount: 2, members: [{ tag: '#KEEP' }] };
    return {};
  });
  try {
    fleet.slots[0].clubState = 'joined';
    fleet.slots[0].tag = '#KEEP';
    fleet.slots[1].clubState = 'joined';
    fleet.slots[1].tag = '#KICKED';
    await fleet.checkClub(Date.now());
    assert.equal(fleet.slots[0].clubState, 'joined', 'оставшийся в клубе не трогаем');
    assert.equal(fleet.slots[1].clubState, 'want', 'выкинутого вернули в очередь');
    assert.equal(fleet.slots[1].joined, false);
  } finally {
    restore();
    fleet.stop();
    clean(root);
  }
});

test('после лимита попыток слот помечается failed', async () => {
  const { root, fleet } = setup({ clubFillMaxAttempts: 1, clubFillConcurrency: 1 });
  const restore = stubActions(async (client, action) => {
    if (action === 'club-info') return { full: false, memberCount: 5, members: [] };
    return {};
  });
  try {
    fleet.clients.get(1).joinRefuses = true;
    fleet.wantClub([1]);
    await sleep(80);
    const slot = fleet.slots.find((s) => s.index === 1);
    assert.equal(slot.clubState, 'failed');
    assert.match(slot.clubError, /заполнен/);
  } finally {
    restore();
    fleet.stop();
    clean(root);
  }
});

test('club-cancel снимает очередь и выключает автоподписку', async () => {
  const { root, fleet } = setup();
  const restore = stubActions(async (client, action) => {
    if (action === 'club-info') return { full: true, memberCount: 50, members: [] };
    return {};
  });
  try {
    fleet.wantClub([1, 2]);
    await sleep(20);
    const cancelled = fleet.cancelClub(null);
    assert.equal(cancelled.cancelled, 2);
    assert.equal(fleet.clubFill, false);
    assert.deepEqual(fleet.slots.map((s) => s.clubState), [null, null, null]);
  } finally {
    restore();
    fleet.stop();
    clean(root);
  }
});
