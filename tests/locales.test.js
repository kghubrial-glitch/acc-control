const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveLocaleIndex } = require('../lib/Locales');
const Login = require('../Messaging/Messages/Client/LoginMessage');

test('resolveLocaleIndex maps locale strings to the LOCALE table order', () => {
  assert.equal(resolveLocaleIndex('en-US'), 0);
  assert.equal(resolveLocaleIndex('zh-CN'), 1);
  assert.equal(resolveLocaleIndex('ar-SA'), 2);
  assert.equal(resolveLocaleIndex('ar'), 2);
  assert.equal(resolveLocaleIndex('RU'), 17);
  assert.equal(resolveLocaleIndex('ru-RU'), 17);
  assert.equal(resolveLocaleIndex('tr-TR'), 18);
  assert.equal(resolveLocaleIndex('en'), 0);
  assert.equal(resolveLocaleIndex('bogus'), 0, 'unknown locale falls back to English by default');
  assert.equal(resolveLocaleIndex('bogus', 2), 2, 'explicit fallback wins for unknown locale');
  assert.equal(resolveLocaleIndex(2), 2, 'a numeric index passes through');
});

test('LoginMessage sends the preferredLanguage DataReference for the configured locale', () => {
  const enc = ({ locale, localeIndex }) => {
    const l = new Login({ locale }, { locale, localeIndex });
    l.encode();
    const s = l.ByteStream;
    s.set(s.getBytes());
    s.readLong();          // accountId
    s.readOptionalString(); // passToken
    s.readInt();            // clientMajor
    s.readInt();            // literal 1
    s.readInt();            // clientBuild
    s.readOptionalString(); // fingerprintHash
    s.readOptionalString(); // deviceId
    return { cls: s.readVInt(), index: s.readVInt(), deviceLocale: s.readOptionalString() };
  };
  const arabic = enc({ locale: 'ar-SA', localeIndex: 2 });
  assert.equal(arabic.cls, 1, 'locale data class');
  assert.equal(arabic.index, 2, 'Arabic index from csv_logic/locales.csv');
  assert.equal(arabic.deviceLocale, 'ar-SA');

  const english = enc({ locale: 'en-US', localeIndex: 0 });
  assert.equal(english.cls, 1);
  assert.equal(english.index, 0, 'English is index 0');
  assert.equal(english.deviceLocale, 'en-US');
});