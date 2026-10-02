import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const localesDir = join(root, '_locales');
const srcDir = join(root, 'src');

function loadMessages(locale) {
  return JSON.parse(readFileSync(join(localesDir, locale, 'messages.json'), 'utf8'));
}

function placeholderTokens(message) {
  const tokens = [];
  const re = /\$[A-Z][A-Z0-9_]*\$|\$[1-9][0-9]*/g;
  let m;
  while ((m = re.exec(String(message || '')))) tokens.push(m[0]);
  return tokens;
}

function tokenSet(message) {
  return [...new Set(placeholderTokens(message))].sort();
}

function walkFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkFiles(p, out);
    else out.push(p);
  }
  return out;
}

function collectUsedKeys() {
  const used = new Set();
  const tRe = /\bt\(\s*['"]([^'"]+)['"]/g;
  const dataRe = /\bdata-i18n(?:-title|-aria-label|-placeholder)?=["']([^"']+)["']/g;
  for (const file of walkFiles(srcDir)) {
    if (!/\.(js|html)$/.test(file)) continue;
    const text = readFileSync(file, 'utf8');
    let m;
    tRe.lastIndex = 0;
    while ((m = tRe.exec(text))) used.add(m[1]);
    dataRe.lastIndex = 0;
    while ((m = dataRe.exec(text))) used.add(m[1]);
  }
  return used;
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function parseAttrs(raw) {
  const attrs = {};
  const re = /([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+)))?/g;
  let m;
  while ((m = re.exec(raw))) {
    attrs[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

function assertHtmlI18n(rel) {
  const html = readFileSync(join(root, rel), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!doctype[^>]*>/i, '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, '');
  const re = /<(\/)?([a-zA-Z][\w:-]*)([^>]*?)(\/)?>|([^<]+)/g;
  const stack = [];
  let m;
  while ((m = re.exec(html))) {
    if (m[5] != null) {
      const text = decodeEntities(m[5]).replace(/\s+/g, ' ').trim();
      if (!text || !/[A-Za-z]/.test(text)) continue;
      const covered = stack.some((s) => s.tag === 'code' || s.attrs['data-i18n']);
      assert.ok(
        covered,
        `${rel}: Latin text without data-i18n: ${JSON.stringify(text)}`,
      );
      continue;
    }
    const closing = !!m[1];
    const tag = m[2].toLowerCase();
    const self = !!m[4] || VOID.has(tag);
    if (closing) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag === tag) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const attrs = parseAttrs(m[3] || '');
    const checks = [
      ['title', 'data-i18n-title'],
      ['aria-label', 'data-i18n-aria-label'],
      ['placeholder', 'data-i18n-placeholder'],
    ];
    for (const [name, need] of checks) {
      const val = attrs[name];
      if (!val || !/[A-Za-z]/.test(val)) continue;
      assert.ok(attrs[need], `${rel}: <${tag} ${name}> is missing ${need}`);
    }
    if (!self) stack.push({ tag, attrs });
  }
}

const locales = readdirSync(localesDir).filter((name) =>
  statSync(join(localesDir, name)).isDirectory(),
);
const en = loadMessages('en');
const enKeys = Object.keys(en).sort();

test('every locale has the same message keys as en', () => {
  assert.ok(locales.includes('en'));
  assert.ok(locales.includes('zh_CN'));
  assert.ok(locales.includes('zh_TW'));
  for (const loc of locales) {
    const keys = Object.keys(loadMessages(loc)).sort();
    assert.deepEqual(keys, enKeys, `${loc} key set differs from en`);
  }
});

test('placeholder tokens in each locale match en', () => {
  for (const loc of locales) {
    if (loc === 'en') continue;
    const messages = loadMessages(loc);
    for (const key of enKeys) {
      assert.deepEqual(
        tokenSet(messages[key].message),
        tokenSet(en[key].message),
        `${loc}.${key} placeholders differ from en`,
      );
    }
  }
});

test('source t() and data-i18n keys match en (except extName/extDesc)', () => {
  const used = collectUsedKeys();
  for (const key of used) {
    if (key.startsWith('@@')) continue;
    assert.ok(Object.hasOwn(en, key), `used key missing from en: ${key}`);
  }
  for (const key of enKeys) {
    if (key === 'extName' || key === 'extDesc') continue;
    assert.ok(used.has(key), `en key is not referenced: ${key}`);
  }
});

test('popup and options HTML Latin copy has data-i18n*', () => {
  assertHtmlI18n('src/popup/popup.html');
  assertHtmlI18n('src/options/options.html');
});
