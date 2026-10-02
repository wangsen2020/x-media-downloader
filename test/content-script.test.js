import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { isExtensionContextValid, t } from '../src/lib/i18n.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('invalid context silently disables translations', () => {
  const previous = globalThis.chrome;
  const warn = console.warn;
  let warnings = 0;
  console.warn = () => warnings++;
  try {
    for (const runtime of [undefined, {}, { id: 'old', getURL() { throw new Error('Extension context invalidated'); } }]) {
      globalThis.chrome = { runtime, i18n: { getMessage: () => '' } };
      assert.equal(isExtensionContextValid(), false);
      assert.equal(t('batchClose'), '');
    }
    assert.equal(warnings, 0);
  } finally {
    console.warn = warn;
    if (previous === undefined) delete globalThis.chrome;
    else globalThis.chrome = previous;
  }
});

test('classic content guard disconnects observer and disposes batch once', () => {
  const source = readFileSync(join(root, 'src/content.js'), 'utf8');
  const start = source.indexOf('  function contextValid()');
  const guard = source.slice(start, source.indexOf('  if (!contextValid()) return;', start));
  const calls = [];
  const ctx = vm.createContext({
    invalidated: false, chrome: { runtime: { id: undefined } },
    mo: { disconnect: () => calls.push('disconnect') },
    batchApi: { dispose: () => calls.push('dispose') }, scanTimer: 1, contextTimer: 2,
    cancelAnimationFrame: () => calls.push('cancel'), clearInterval: () => calls.push('clear'),
  });
  vm.runInContext(guard, ctx);
  assert.equal(ctx.contextValid(), false);
  assert.equal(ctx.contextValid(), false);
  assert.deepEqual(calls, ['disconnect', 'cancel', 'clear', 'dispose']);
});

test('batch close label is translated in all nine locales', () => {
  for (const locale of ['en', 'zh_CN', 'zh_TW', 'ja', 'ko', 'es', 'es_419', 'pt_BR', 'ar']) {
    const messages = JSON.parse(readFileSync(join(root, '_locales', locale, 'messages.json'), 'utf8'));
    assert.ok(messages.batchClose.message.trim(), locale);
    assert.ok(!messages.batchClose.message.includes('?'), locale);
  }
});

// Chrome ignores content_scripts.type and then throws "Cannot use import
// statement outside a module", which drops the whole content script.
// node --check cannot see that while package.json says "type": "module".
const TOP_LEVEL = /^\s*(?:import(?:\s|["'*{])|export(?:\s|[{*]))/;

test('manifest content scripts are classic scripts', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  const entries = manifest.content_scripts || [];
  assert.ok(entries.length > 0, 'manifest has no content scripts');
  for (const entry of entries) {
    assert.equal(Object.hasOwn(entry, 'type'), false, 'content_scripts entry must not have a type key');
    for (const rel of entry.js || []) {
      const lines = readFileSync(join(root, rel), 'utf8').split(/\r?\n/);
      const hit = lines.find((line) => TOP_LEVEL.test(line));
      assert.equal(hit, undefined, `${rel} has a top-level import or export`);
    }
  }
});
