// Package the extension into a store-ready zip (forward-slash paths, no junk).
// Prefers `git archive` (respects .gitignore, only tracked files); falls back
// to PowerShell / `zip` when not in a git work tree.
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, existsSync } from 'node:fs';
import { platform } from 'node:process';

const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url)),
);
const out = `x-media-downloader-${version}.zip`;
if (existsSync(out)) rmSync(out);

function run(cmd, args) {
  execFileSync(cmd, args, { stdio: 'inherit' });
}

let usedGit = false;
try {
  execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { stdio: 'ignore' });
  run('git', ['archive', '--format=zip', '-o', out, 'HEAD']);
  usedGit = true;
} catch {
  const include = ['manifest.json', 'icons', 'src', 'LICENSE', 'README.md'];
  if (platform === 'win32') {
    const list = include.map((p) => `'${p}'`).join(',');
    run('powershell', [
      '-NoProfile',
      '-Command',
      `Compress-Archive -Path ${list} -DestinationPath '${out}' -Force`,
    ]);
  } else {
    run('zip', ['-r', out, ...include, '-x', '*.DS_Store']);
  }
}

console.log(`\nCreated ${out}${usedGit ? ' (git archive)' : ''}`);
