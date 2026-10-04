import test from 'node:test';
import assert from 'node:assert/strict';
import { clearHistory, clearDownloaded } from '../src/lib/store.js';

test('startup and updates register feedback; only install saves a local date and opens welcome', async () => {
  const data = {};
  const tabs = [];
  const urls = [];
  let onInstalled;
  let fail = false;
  globalThis.chrome = {
    storage: { local: {
      async get(key) { return { [key]: data[key] }; },
      async set(values) { Object.assign(data, values); },
    } },
    i18n: { getUILanguage: () => 'pt-PT' },
    runtime: {
      getManifest: () => ({ version: '1.5.4' }),
      async setUninstallURL(url) {
        if (fail) throw new Error('registration failed');
        urls.push(url);
      },
      onInstalled: { addListener(fn) { onInstalled = fn; } },
      onMessage: { addListener() {} },
    },
    downloads: { onChanged: { addListener() {} } },
    tabs: { async create(options) {
      assert.ok(data.installedDate, 'install date is saved before opening welcome');
      tabs.push(options.url);
    } },
  };
  await import('../src/background.js?site-lifecycle');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(urls.length, 1);
  assert.equal(new URL(urls[0]).searchParams.has('installed'), false);
  await onInstalled({ reason: 'update' });
  await onInstalled({ reason: 'chrome_update' });
  assert.equal(data.installedDate, undefined);
  assert.equal(tabs.length, 0);
  assert.equal(urls.length, 2);
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  await onInstalled({ reason: 'install' });
  assert.equal(data.installedDate, today);
  assert.equal(new URL(tabs[0]).pathname, '/pt-br/welcome');
  assert.equal(new URL(urls.at(-1)).searchParams.get('installed'), today);
  data.installedDate = '2026-01-02';
  await onInstalled({ reason: 'install' });
  await clearHistory();
  await clearDownloaded();
  await onInstalled({ reason: 'update' });
  assert.equal(data.installedDate, '2026-01-02');
  assert.equal(tabs.length, 2);
  assert.equal(new URL(urls.at(-1)).searchParams.get('installed'), '2026-01-02');
  fail = true;
  await onInstalled({ reason: 'update' });
  await import('../src/background.js?site-startup-failure');
  await new Promise(resolve => setImmediate(resolve));
});
