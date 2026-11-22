const test = require('node:test'),
  assert = require('node:assert/strict');
const { parseSelection } = require('../lib/Selection');

const available = [1, 2, 3, 4, 5, 10, 11, 12];

test('all / * / пусто — весь набор', () => {
  assert.deepEqual(parseSelection('all', available), available);
  assert.deepEqual(parseSelection('*', available), available);
  assert.deepEqual(parseSelection('', available), available);
});

test('одиночные индексы и списки', () => {
  assert.deepEqual(parseSelection('5', available), [5]);
  assert.deepEqual(parseSelection('5,1,12', available), [1, 5, 12]);
  assert.deepEqual(parseSelection('99', available), [], 'несуществующий индекс игнорируется');
});

test('диапазоны: 3-5, 10-, -3', () => {
  assert.deepEqual(parseSelection('3-5', available), [3, 4, 5]);
  assert.deepEqual(parseSelection('5-3', available), [3, 4, 5], 'обратный диапазон нормализуется');
  assert.deepEqual(parseSelection('10-', available), [10, 11, 12]);
  assert.deepEqual(parseSelection('-3', available), [1, 2, 3]);
});

test('first / last / random / чётность', () => {
  assert.deepEqual(parseSelection('first:3', available), [1, 2, 3]);
  assert.deepEqual(parseSelection('last:2', available), [11, 12]);
  assert.deepEqual(parseSelection('even', available), [2, 4, 10, 12]);
  assert.deepEqual(parseSelection('odd', available), [1, 3, 5, 11]);
  assert.equal(parseSelection('random:3', available).length, 3);
  assert.equal(parseSelection('random:50%', available).length, 4);
});

test('неверное выражение даёт понятную ошибку', () => {
  assert.throws(() => parseSelection('abc', available), /неверный выбор ботов/);
});
