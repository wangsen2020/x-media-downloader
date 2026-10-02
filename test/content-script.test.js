import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

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
