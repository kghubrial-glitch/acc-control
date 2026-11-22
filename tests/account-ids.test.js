const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const Accounts = require('../lib/Accounts');
const Fleet = require('../lib/Fleet');
const Selection = require('../lib/Selection');

const tempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nulls-ids-'));
const clean = (root) => fs.rmSync(root, { recursive: true, force: true });

function seed(root, files) {
  fs.mkdirSync(path.join(root, 'accounts'), { recursive: true });
  for (const [name, account] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, 'accounts', name), JSON.stringify(account));
  }
}

test('ensureIds проставляет ID и идемпотентен', () => {
  const root = tempRoot();
  try {
    seed(root, {
      'bot-1.json': { passToken: 't1', hi: 0, lo: 1 },
      'probe.json': { passToken: 't2', hi: 0, lo: 2, name: 'Probe' },
      'empty.json': {},
    });
    const first = Accounts.ensureIds(root);
    assert.equal(first.changed, 2, 'заготовка без токена не получает id');
    const bot1 = JSON.parse(fs.readFileSync(path.join(root, 'accounts', 'bot-1.json')));
    const probe = JSON.parse(fs.readFileSync(path.join(root, 'accounts', 'probe.json')));
    const empty = JSON.parse(fs.readFileSync(path.join(root, 'accounts', 'empty.json')));
    assert.ok(Accounts.validId(bot1.id));
    assert.ok(Accounts.validId(probe.id));
    assert.notEqual(bot1.id, probe.id);
    assert.equal(empty.id, undefined);
    assert.equal(Accounts.ensureIds(root).changed, 0);
    assert.equal(Accounts.ensureIds(root).ids.get('probe.json'), probe.id);
  } finally {
    clean(root);
  }
});

test('find принимает @id и голый id', () => {
  const root = tempRoot();
  try {
    seed(root, {
      'bot-1.json': { passToken: 't', hi: 0, lo: 1 },
      'bot-2.json': { passToken: 't', hi: 0, lo: 2 },
    });
    const ids = Accounts.ensureIds(root).ids;
    const id1 = ids.get('bot-1.json');
    assert.equal(Accounts.find(root, '@' + id1).file, 'bot-1.json');
    assert.equal(Accounts.find(root, id1).file, 'bot-1.json');
    assert.equal(Accounts.find(root, '@nope'), null);
  } finally {
    clean(root);
  }
});

test('флот подхватывает ID слота и выбирает по нему', () => {
  const root = tempRoot();
  try {
    seed(root, {
      'bot-1.json': { passToken: 't', hi: 0, lo: 1 },
      'bot-2.json': { passToken: 't', hi: 0, lo: 2 },
    });
    const ids = Accounts.ensureIds(root).ids;
    const fleet = new Fleet(root, { indexes: [1, 2] });
    try {
      assert.equal(fleet.slots[0].id, ids.get('bot-1.json'));
      assert.equal(fleet.slots[1].id, ids.get('bot-2.json'));
      assert.deepEqual(fleet.resolveIndexes({ ids: [ids.get('bot-2.json')] }), [2]);
      assert.deepEqual(fleet.resolveIndexes({ id: ids.get('bot-1.json') }), [1]);
      assert.deepEqual(fleet.resolveIndexes({ select: '@' + ids.get('bot-2.json') }), [2]);
      assert.deepEqual(fleet.resolveIndexes({ select: '@' + ids.get('bot-2.json') + ',' + ids.get('bot-1.json') }), [1, 2]);
    } finally {
      fleet.stop();
    }
  } finally {
    clean(root);
  }
});

test('Selection: выбор по @id и по точному id', () => {
  const byId = new Map([
    ['abc123', 7],
    ['zzz999', 3],
  ]);
  assert.deepEqual(Selection.parseSelection('@abc123', [3, 7], byId), [7]);
  assert.deepEqual(Selection.parseSelection('zzz999,@abc123', [3, 7], byId), [3, 7]);
  assert.throws(() => Selection.parseSelection('@abc123', [3], byId), /не найден/); // id есть, но бота нет в available
  assert.throws(() => Selection.parseSelection('@missing', [3, 7], byId), /не найден/);
});