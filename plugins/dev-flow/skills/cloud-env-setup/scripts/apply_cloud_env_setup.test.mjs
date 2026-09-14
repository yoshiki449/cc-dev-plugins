// 実行: node --test plugins/dev-flow/skills/cloud-env-setup/scripts/apply_cloud_env_setup.test.mjs
//
// クラウドセッションはユーザー設定の plugin を持ち込まず、リポジトリの .claude/settings.json に
// 宣言したものだけをセッション開始時にインストールする。宣言が1つ欠けても手元では何も起きないので、
// 生成物の中身をここで固定する。

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'apply_cloud_env_setup.sh');
const MARKETPLACE_URL = 'https://github.com/yoshiki449/cc-dev-plugins.git';
const HOOK_COMMAND = '"$CLAUDE_PROJECT_DIR"/scripts/install_pkgs.sh';

function tempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-env-setup-'));
  execFileSync('git', ['init', '-q', dir]);
  return dir;
}

function apply(dir, args = []) {
  const r = spawnSync('bash', [SCRIPT, ...args, dir], { encoding: 'utf8' });
  assert.equal(r.status, 0, `apply が失敗した: ${r.stderr}`);
  return r;
}

const settingsOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'));
const hookEntries = (s) => (s.hooks?.SessionStart ?? []).flatMap((e) => e.hooks ?? []).filter((h) => h.command === HOOK_COMMAND);

test('新規リポジトリに marketplace と3つの plugin を宣言する', () => {
  const dir = tempRepo();
  apply(dir);
  const s = settingsOf(dir);
  assert.deepEqual(s.extraKnownMarketplaces['cc-dev-plugins'], { source: { source: 'git', url: MARKETPLACE_URL } });
  assert.deepEqual(s.enabledPlugins, {
    'dev-flow@cc-dev-plugins': true,
    'poc-flow@cc-dev-plugins': true,
    'git-secret-guard@cc-dev-plugins': true,
  });
});

test('cc-meta は宣言しない（~/.cc-plugins/.env が無いクラウドでは exit 2 で止まる）', () => {
  const dir = tempRepo();
  apply(dir);
  assert.equal(Object.keys(settingsOf(dir).enabledPlugins).some((k) => k.startsWith('cc-meta@')), false);
});

test('2回実行しても settings.json が変わらない（hook も plugin も重複しない）', () => {
  const dir = tempRepo();
  apply(dir);
  const first = fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8');
  apply(dir);
  assert.equal(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'), first);
  assert.equal(hookEntries(settingsOf(dir)).length, 1);
});

test('既存の設定を残し、明示的に false にした plugin を true に戻さない', () => {
  const dir = tempRepo();
  fs.mkdirSync(path.join(dir, '.claude'));
  fs.writeFileSync(
    path.join(dir, '.claude', 'settings.json'),
    JSON.stringify({
      permissions: { allow: ['Bash(npm test)'] },
      enabledPlugins: { 'poc-flow@cc-dev-plugins': false, 'other@elsewhere': true },
      extraKnownMarketplaces: { elsewhere: { source: { source: 'github', repo: 'x/y' } } },
    }),
  );
  apply(dir);
  const s = settingsOf(dir);
  assert.deepEqual(s.permissions, { allow: ['Bash(npm test)'] });
  assert.equal(s.enabledPlugins['poc-flow@cc-dev-plugins'], false);
  assert.equal(s.enabledPlugins['other@elsewhere'], true);
  assert.equal(s.enabledPlugins['dev-flow@cc-dev-plugins'], true);
  assert.ok(s.extraKnownMarketplaces.elsewhere);
});

test('--no-plugins のときは plugin を宣言しない', () => {
  const dir = tempRepo();
  apply(dir, ['--no-plugins']);
  const s = settingsOf(dir);
  assert.equal(s.enabledPlugins, undefined);
  assert.equal(s.extraKnownMarketplaces, undefined);
  assert.equal(hookEntries(s).length, 1);
});

test('worktree（.git がファイル）でも実行できる', () => {
  const main = tempRepo();
  execFileSync('git', ['-C', main, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init']);
  const wt = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-env-wt-')), 'wt');
  execFileSync('git', ['-C', main, 'worktree', 'add', '-q', wt]);
  apply(wt);
  assert.ok(settingsOf(wt).enabledPlugins['dev-flow@cc-dev-plugins']);
});

test('install_pkgs.sh はローカルでは何もせず、クラウドでは scripts/cloud-session-init.sh を呼ぶ', () => {
  const dir = tempRepo();
  apply(dir);
  fs.writeFileSync(path.join(dir, 'scripts', 'cloud-session-init.sh'), 'touch "$CLAUDE_PROJECT_DIR/init-ran"\n');
  const run = (remote) =>
    spawnSync('bash', [path.join(dir, 'scripts', 'install_pkgs.sh')], {
      cwd: os.tmpdir(),
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir, CLAUDE_CODE_REMOTE: remote },
    });

  const local = run('');
  assert.equal(local.status, 0);
  assert.equal(fs.existsSync(path.join(dir, 'init-ran')), false, 'ローカルで初期化スクリプトが走った');

  const cloud = run('true');
  assert.equal(cloud.status, 0, cloud.stderr);
  assert.equal(fs.existsSync(path.join(dir, 'init-ran')), true, 'クラウドで初期化スクリプトが走っていない');
});

test('既存の install_pkgs.sh は上書きしない', () => {
  const dir = tempRepo();
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.writeFileSync(path.join(dir, 'scripts', 'install_pkgs.sh'), '# 手書き\n');
  apply(dir);
  assert.equal(fs.readFileSync(path.join(dir, 'scripts', 'install_pkgs.sh'), 'utf8'), '# 手書き\n');
});
