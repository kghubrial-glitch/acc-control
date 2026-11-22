// Генерация ников для новых аккаунтов флота.
//
// Опции (camelCase, как в Fleet):
//   template  шаблон, например "NW{index}" или "{word}_{pad3}" — плейсхолдеры:
//             {index}/{n} — номер слота, {ordinal}/{i} — позиция в наборе (с 1),
//             {rand} — случайные 5 символов, {word} — случайное слово,
//             {pad3} — номер слота с ведущими нулями (3 знака)
//   prefix, suffix, separator  части вокруг номера (если нет template)
//   start     с какого числа нумеровать (по умолчанию — номер слота)
//   pad       ширина номера с ведущими нулями (0 — без ведущих нулей)
//   transform upper | lower | capital
//   list      готовые ники по порядку (для первых позиций)
//   random    вместо номера — случайное слово + номер
//   maxLength предел длины (по умолчанию 15)
const WORD_POOL = [
  'Ace','Blaze','Bolt','Brave','Breeze','Cobra','Comet','Dash','Delta','Echo','Falcon','Flash','Frost','Ghost','Glide',
  'Hawk','Hydro','Iron','Jade','Jolt','Kilo','Lunar','Mako','Neon','Nova','Onyx','Orbit','Panda','Pixel','Pulse','Quartz',
  'Rapid','Raven','Rogue','Saber','Shadow','Sigma','Sonic','Spark','Storm','Swift','Tango','Titan','Turbo','Venom','Viper',
  'Vortex','Wolf','Xenon','Zenith','Arrow','Beam','Cipher','Drift','Ember','Fury','Gale','Halo','Ion','Jet','Knight',
  'Laser','Meteor','Nitro','Omega','Phantom','Quasar','Rocket','Solar','Thunder','Ultra','Vivid','Warp','Zephyr','Alpha',
];

const DEFAULT_MAX = 15;

function normalizeOptions(options = {}) {
  return {
    template: options.template || options.nameTemplate || '',
    prefix: options.prefix ?? options.namePrefix ?? 'Bot',
    suffix: options.suffix ?? options.nameSuffix ?? '',
    separator: options.separator ?? options.nameSeparator ?? '',
    start: options.start ?? options.nameStart,
    pad: Number(options.pad ?? options.namePad ?? 0) || 0,
    transform: options.transform || options.nameCase || '',
    list: options.list || options.names || null,
    random: !!(options.random ?? options.nameRandom),
    maxLength: Number(options.maxLength ?? options.nameMax ?? DEFAULT_MAX) || DEFAULT_MAX,
    rand: options.rand || Math.random,
  };
}

function randomWord(rand) {
  return WORD_POOL[Math.floor(rand() * WORD_POOL.length)];
}

function randomToken(rand, length = 5) {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[Math.floor(rand() * alphabet.length)];
  return out;
}

function padNumber(value, width) {
  const text = String(Math.trunc(Math.abs(value)));
  if (!width) return text;
  return text.padStart(width, '0');
}

// Приводим ник к допустимому виду: только латиница/цифры/подчёркивание, без
// пробелов и мусора, ограничение длины. Сервер всё равно валидирует ник, но так
// мы не отправляем заведомо неверные значения и не блокируем аккаунт.
function sanitizeName(value, maxLength = DEFAULT_MAX) {
  const cleaned = String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9_]/g, '')
    .slice(0, maxLength);
  return cleaned;
}

function applyTransform(value, transform) {
  if (transform === 'upper') return value.toUpperCase();
  if (transform === 'lower') return value.toLowerCase();
  if (transform === 'capital') return value ? value[0].toUpperCase() + value.slice(1) : value;
  return value;
}

function renderTemplate(template, slot, ordinal, rand) {
  return template
    .replace(/\{pad(\d+)\}/g, (_, width) => padNumber(slot, Number(width)))
    .replace(/\{index\}|\{n\}/g, String(slot))
    .replace(/\{ordinal\}|\{i\}/g, String(ordinal))
    .replace(/\{rand\}/g, randomToken(rand))
    .replace(/\{word\}/g, randomWord(rand));
}

// Генератор с защитой от дублей в пределах одного запуска.
function createNameGenerator(options = {}) {
  const o = normalizeOptions(options);
  const used = new Set();
  return function name(slot, ordinal = 1) {
    let base;
    if (Array.isArray(o.list) && o.list[ordinal - 1] != null) {
      base = String(o.list[ordinal - 1]);
    } else if (o.template) {
      base = renderTemplate(o.template, slot, ordinal, o.rand);
    } else {
      const number = o.start != null ? Number(o.start) + (ordinal - 1) : slot;
      const numeric = padNumber(number, o.pad);
      const core = o.random ? `${randomWord(o.rand)}${numeric}` : numeric;
      base = [o.prefix, core, o.suffix].filter((part) => part !== '' && part != null).join(o.separator);
    }
    let candidate = applyTransform(sanitizeName(base, o.maxLength), o.transform);
    if (!candidate) candidate = applyTransform(sanitizeName(`Bot${slot}`, o.maxLength), o.transform);
    // Уникальность: при совпадении наращиваем номер в конце.
    if (used.has(candidate)) {
      const stem = candidate.slice(0, Math.max(1, o.maxLength - 2));
      let n = 2;
      while (used.has(`${stem}${n}`)) n++;
      candidate = `${stem}${n}`.slice(0, o.maxLength);
    }
    used.add(candidate);
    return candidate;
  };
}

module.exports = { createNameGenerator, sanitizeName, renderTemplate, WORD_POOL };
