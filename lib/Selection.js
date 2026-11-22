// Выбор произвольного набора ботов для любого действия.
//
// Спецификация (через запятую):
//   5           один индекс
//   1,3,9       список
//   4-10        диапазон
//   50-         от 50 до последнего
//   -20         от первого до 20
//   first:10    первые 10 существующих
//   last:10     последние 10 существующих
//   random:8    8 случайных
//   random:25%  25% случайных
//   even/odd    чётные/нечётные
//   all / *     все
//   @abc123     аккаунт по уникальному ID (byId: Map(id → index))
// Индексы, которых нет в available, игнорируются; результат отсортирован.
function parseSelection(spec, available, byId = null) {
  const all = [...new Set(available)].filter(Number.isInteger).sort((a, b) => a - b);
  if (!all.length) return [];
  const text = String(spec ?? '').trim().toLowerCase();
  if (!text || text === 'all' || text === '*') return all;

  const pick = new Set();
  const addId = (token) => {
    const id = token.replace(/^@/, '');
    const index = byId ? byId.get(id) : null;
    if (Number.isInteger(index) && all.includes(index)) pick.add(index);
    else throw new Error(`аккаунт с ID ${id} не найден среди выбранных ботов`);
  };
  const addRange = (from, to) => {
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    for (const n of all) if (n >= lo && n <= hi) pick.add(n);
  };
  const min = all[0];
  const max = all[all.length - 1];

  for (const raw of text.split(',')) {
    const part = raw.trim();
    if (!part) continue;
    let m;
    if ((m = /^(first|last|random|sample):(\d+)(%?)$/.exec(part))) {
      const kind = m[1];
      const amount = Number(m[2]);
      const percent = m[3] === '%';
      if (kind === 'first') {
        addRange(min, min + amount - 1);
      } else if (kind === 'last') {
        addRange(max - amount + 1, max);
      } else {
        const size = percent ? Math.round((all.length * amount) / 100) : amount;
        for (const n of shuffled(all).slice(0, Math.max(0, size))) pick.add(n);
      }
      continue;
    }
    if (part === 'even' || part === 'odd') {
      const wanted = part === 'even' ? 0 : 1;
      for (const n of all) if (Math.abs(n % 2) === wanted) pick.add(n);
      continue;
    }
    if ((m = /^(\d+)-(\d+)$/.exec(part))) {
      addRange(Number(m[1]), Number(m[2]));
      continue;
    }
    if ((m = /^(\d+)-$/.exec(part))) {
      // "5-" → от 5 до последнего.
      addRange(Number(m[1]), max);
      continue;
    }
    if ((m = /^-(\d+)$/.exec(part))) {
      // "-20" → от первого до 20.
      addRange(min, Number(m[1]));
      continue;
    }
    if (part.startsWith('@')) {
      addId(part);
      continue;
    }
    if (/^\d+$/.test(part)) {
      const n = Number(part);
      if (all.includes(n)) pick.add(n);
      continue;
    }
    // Токен, совпадающий с ID аккаунта (например, 6-символьная строка) тоже допустим.
    if (byId && byId.has(part)) {
      addId(part);
      continue;
    }
    throw new Error(
      `неверный выбор ботов ${JSON.stringify(part)}: используйте 5, 4-10, 50-, first:10, last:10, random:8, even, odd, @account-id, all`,
    );
  }
  return all.filter((n) => pick.has(n));
}

function shuffled(values) {
  const copy = [...values];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

module.exports = { parseSelection };
