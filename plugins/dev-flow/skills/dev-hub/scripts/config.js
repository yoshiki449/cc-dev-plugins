'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_EXCLUDE_DIRS = new Set([
  'node_modules',
  '.git',
  '.cache',
  '.next',
  '.turbo',
  '.vercel',
  '.svelte-kit',
  '.nuxt',
  '.parcel-cache',
  '.yarn',
  '.pnpm-store',
  'dist',
  'build',
  'out',
  'coverage',
  '.venv',
  'venv',
  'env',
  '__pycache__',
  '.pytest_cache',
  '.ruff_cache',
  '.mypy_cache',
  '.tox',
  'target',
  'vendor',
  '.terraform',
  '.gradle',
  '.idea',
  '.vscode',
  '.DS_Store',
  'Library',
  'Applications',
  '.local',
  '.npm',
  '.nvm',
  '.cargo',
  '.rustup',
  '.docker',
  '.kube',
  '.android',
  '.gem',
  '.bundle',
  'snap',
  'playwright-report',
  'blob-report',
]);

function detectHomeDirs() {
  const found = new Set();
  for (const base of ['/home', '/Users']) {
    let entries;
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch (_err) {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;
      if (entry.name === 'shared' || entry.name === 'lost+found') continue;
      found.add(path.join(base, entry.name));
    }
  }
  const home = os.homedir();
  if (fs.existsSync(home)) found.add(home);
  return [...found];
}

function isInDocker() {
  if (fs.existsSync('/.dockerenv')) return true;
  try {
    const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf8');
    if (/docker|containerd|kubepods/.test(cgroup)) return true;
  } catch (_err) {}
  return false;
}

function loadConfig() {
  const home = os.homedir();
  const port = Number.parseInt(process.env.PORT || '7777', 10);
  const inDocker = isInDocker();

  const rawRoots = process.env.SCAN_ROOTS
    ? process.env.SCAN_ROOTS.split(':')
    : detectHomeDirs();

  const scanRoots = rawRoots
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => (p.startsWith('~') ? path.join(home, p.slice(1)) : p));

  const extraExcludes = (process.env.EXCLUDE_DIRS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const excludeDirs = new Set(DEFAULT_EXCLUDE_DIRS);
  for (const d of extraExcludes) excludeDirs.add(d);

  const maxDepth = Number.parseInt(process.env.MAX_DEPTH || '12', 10);

  const videoExtensions = new Set(['.webm', '.mp4', '.mov', '.mkv']);

  // グローバル未取り込み成果物（リポジトリ外）の明示スキャン先
  const rawGlobalDirs = process.env.GLOBAL_DIRS
    ? process.env.GLOBAL_DIRS.split(':')
    : [path.join(home, '.claude', 'explanations'), path.join(home, '.claude', 'plans')];
  const globalDirs = rawGlobalDirs
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => (p.startsWith('~') ? path.join(home, p.slice(1)) : p));

  const host = process.env.HOST || (inDocker ? '0.0.0.0' : '127.0.0.1');
  const allowDelete = process.env.ALLOW_DELETE === '1';

  return {
    port,
    scanRoots,
    excludeDirs,
    maxDepth,
    videoExtensions,
    globalDirs,
    host,
    inDocker,
    allowDelete,
  };
}

module.exports = { loadConfig, DEFAULT_EXCLUDE_DIRS };
