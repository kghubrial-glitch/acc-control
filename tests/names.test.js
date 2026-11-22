const test = require('node:test'),
  assert = require('node:assert/strict');
const { createNameGenerator, sanitizeName } = require('../lib/Names');

test('шаблон с {index} и {ordinal}', () => {
  const name = createNameGenerator({ template: 'NW{index}' });
  assert.equal(name(7, 1), 'NW7');
  const ordinal = createNameGenerator({ template: 'B{ordinal}x{index}' });
  assert.equal(ordinal(50, 3), 'B3x50');
});

test('префикс/суффикс/разделитель/паддинг/нумерация', () => {
  const name = createNameGenerator({ prefix: 'Bot', suffix: 'X', separator: '_', start: 1, pad: 3 });
  assert.equal(name(99, 1), 'Bot_001_X');
  assert.equal(name(99, 2), 'Bot_002_X');
});

test('готовый список имён по порядку, затем генерация', () => {
  const name = createNameGenerator({ list: ['Alpha', 'Bravo'], prefix: 'Bot' });
  assert.equal(name(1, 1), 'Alpha');
  assert.equal(name(2, 2), 'Bravo');
  assert.equal(name(3, 3), 'Bot3');
});

test('случайные имена детерминированы при подмене rand', () => {
  let calls = 0;
  const rand = () => (calls++ % 10) / 10;
  const name = createNameGenerator({ random: true, rand });
  const value = name(5, 1);
  assert.match(value, /^[A-Za-z]+5$/, `неожиданное имя: ${value}`);
});

test('sanitize: только безопасные символы и ограничение длины', () => {
  assert.equal(sanitizeName('Hello World! 12'), 'HelloWorld12');
  assert.equal(sanitizeName('a-very-long-name-here', 10), 'averylongn');
});

test('генератор не выдаёт дубли', () => {
  const name = createNameGenerator({ template: 'Same' });
  assert.equal(name(1, 1), 'Same');
  assert.equal(name(2, 2), 'Same2');
  assert.equal(name(3, 3), 'Same3');
});

test('преобразование регистра', () => {
  assert.equal(createNameGenerator({ template: 'abc{index}', transform: 'upper' })(2, 1), 'ABC2');
  assert.equal(createNameGenerator({ template: 'ABC{index}', transform: 'lower' })(2, 1), 'abc2');
});
