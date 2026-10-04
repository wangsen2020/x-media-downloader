import test from 'node:test';
import assert from 'node:assert/strict';
import { SITE, siteLocalePrefix, welcomeUrl, uninstallUrl } from '../src/lib/site.js';

const locales = [
  ['zh-CN', '/zh'], ['zh-TW', '/zh'], ['pt-BR', '/pt-br'], ['pt-PT', '/pt-br'],
  ['es-419', '/es'], ['es', '/es'], ['en-US', ''], ['ar', ''], ['ja', ''],
];

test('site locales map to the four supported site languages', () => {
  for (const [lang, prefix] of locales) assert.equal(siteLocalePrefix(lang), prefix);
});

test('welcome and uninstall URLs have the expected paths and query shapes', () => {
  for (const [uiLang, prefix] of locales) {
    const details = { uiLang, version: '1.5.4', installed: '2026-10-05' };
    assert.equal(welcomeUrl(details),
      `${SITE}${prefix}/welcome?utm_source=extension&utm_medium=install&v=1.5.4&hl=${uiLang}`);
    assert.equal(uninstallUrl(details),
      `${SITE}${prefix}/uninstall?utm_source=extension&utm_medium=uninstall&ext=xmd&v=1.5.4&hl=${uiLang}&installed=2026-10-05`);
  }
});

test('unknown install dates are omitted', () => {
  for (const installed of [undefined, null, '']) {
    const url = new URL(uninstallUrl({ uiLang: 'en-US', version: '1.5.4', installed }));
    assert.equal(url.searchParams.has('installed'), false);
  }
});

test('URLs encode query values with URLSearchParams', () => {
  const url = new URL(welcomeUrl({ uiLang: 'en-US', version: '1.5.4&extra=value' }));
  assert.equal(url.searchParams.get('v'), '1.5.4&extra=value');
  assert.equal(url.searchParams.has('extra'), false);
});

test('URLs contain no user identifiers and stay below the Chrome limit', () => {
  for (const [uiLang] of locales) {
    const details = { uiLang, version: '1.5.4', installed: '2026-10-05',
      handle: '@private-user', id: 'private-id', history: ['private-history'] };
    for (const build of [welcomeUrl, uninstallUrl]) {
      const value = build(details);
      assert.ok(value.length < 1023);
      assert.ok(!decodeURIComponent(value).includes('@'));
      assert.ok(!value.includes('private-'));
      const keys = [...new URL(value).searchParams.keys()];
      assert.deepEqual(keys, build === welcomeUrl
        ? ['utm_source', 'utm_medium', 'v', 'hl']
        : ['utm_source', 'utm_medium', 'ext', 'v', 'hl', 'installed']);
    }
  }
});
