// Locale table mirrored from the game's csv_logic/locales.csv. The row order
// is the index used in the login `preferredLanguage` DataReference (class 1):
// 0=EN, 2=AR (Arabic), 17=RU, 18=TR, 1=CN, ...
const LOCALES = [
  { index: 0, code: 'EN', locale: 'en-US', name: 'English' },
  { index: 1, code: 'CN', locale: 'zh-CN', name: '简体中文' },
  { index: 2, code: 'AR', locale: 'ar', name: 'العربية' },
  { index: 3, code: 'FR', locale: 'fr', name: 'Français' },
  { index: 9, code: 'DE', locale: 'de', name: 'Deutsch' },
  { index: 10, code: 'ES', locale: 'es', name: 'Español' },
  { index: 11, code: 'IT', locale: 'it', name: 'Italiano' },
  { index: 12, code: 'JP', locale: 'ja', name: '日本語' },
  { index: 13, code: 'CNT', locale: 'zh-TW', name: '繁體中文' },
  { index: 14, code: 'KR', locale: 'ko', name: '한국어' },
  { index: 15, code: 'NL', locale: 'nl', name: 'Nederlands' },
  { index: 16, code: 'PT', locale: 'pt-BR', name: 'Português' },
  { index: 17, code: 'RU', locale: 'ru-RU', name: 'Pусский' },
  { index: 18, code: 'TR', locale: 'tr-TR', name: 'Türkçe' },
  { index: 19, code: 'ID', locale: 'id', name: 'Bahasa Indonesia' },
  { index: 20, code: 'MS', locale: 'ms', name: 'Bahasa Melayu' },
  { index: 21, code: 'VI', locale: 'vi', name: 'Tiếng Việt' },
  { index: 22, code: 'TH', locale: 'th', name: 'ภาษาไทย' },
  { index: 23, code: 'FI', locale: 'fi', name: 'Suomi' },
  { index: 26, code: 'PL', locale: 'pl', name: 'Polski' },
  { index: 27, code: 'HE', locale: 'he', name: 'עברית' },
];

function resolveLocaleIndex(value, fallback = 0) {
  if (Number.isInteger(value)) return value;
  if (value === undefined || value === null || value === '') return fallback;
  const key = String(value).trim().toLowerCase();
  for (const locale of LOCALES) {
    if (locale.code.toLowerCase() === key) return locale.index;
    if (locale.locale.toLowerCase() === key) return locale.index;
    if (locale.name.toLowerCase() === key) return locale.index;
  }
  const base = key.split('-')[0]; // ar-SA -> ar
  for (const locale of LOCALES) if (locale.locale.toLowerCase() === base) return locale.index;
  return fallback;
}

function localeLabel(index) {
  const found = LOCALES.find((locale) => locale.index === index);
  return found ? found.name : `Locale ${index}`;
}

module.exports = { LOCALES, resolveLocaleIndex, localeLabel };