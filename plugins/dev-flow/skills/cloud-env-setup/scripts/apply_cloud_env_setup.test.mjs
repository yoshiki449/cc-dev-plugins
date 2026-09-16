// 実行: node --test plugins/dev-flow/skills/cloud-env-setup/scripts/apply_cloud_env_setup.test.mjs
//
// クラウドセッションはリポジトリの .claude/settings.json に宣言した plugin を入れない（2026-09 実測）。
// 宣言を書くとクラウドでは効かないうえ、Setup script で入れた分と二重に出るので、スクリプトは宣言を書かず、
// Setup script のテンプレートで入れさせる。生成物とテンプレートの中身をここで固定する。

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'apply_cloud_env_setup.sh');
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

// 表示された Setup script のうち、実行される行だけ（説明のコメントに禁止語が含まれても反応しないように）
function templateCode(stdout) {
  const [, body = ''] = stdout.split(/^-{20,}$/m);
  return body.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
}

const settingsOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'));
const hookEntries = (s) => (s.hooks?.SessionStart ?? []).flatMap((e) => e.hooks ?? []).filter((h) => h.command === HOOK_COMMAND);

test('settings.json に plugin 宣言を書かず、SessionStart hook だけを置く', () => {
  const dir = tempRepo();
  apply(dir);
  const s = settingsOf(dir);
  assert.equal(s.enabledPlugins, undefined);
  assert.equal(s.extraKnownMarketplaces, undefined);
  assert.equal(hookEntries(s).length, 1);
});

test('Setup script のテンプレートが Claude 起動前に marketplace を足して3つの plugin を user スコープで入れる', () => {
  const dir = tempRepo();
  const out = templateCode(apply(dir).stdout);
  assert.match(out, /claude plugin marketplace add https:\/\/github\.com\/yoshiki449\/cc-dev-plugins\.git/);
  const installs = [...out.matchAll(/^\s*claude plugin install "?\$p@cc-dev-plugins"? --scope user/gm)];
  assert.equal(installs.length, 1);
  assert.match(out, /for p in dev-flow poc-flow git-secret-guard; do/);
  assert.doesNotMatch(out, /cc-meta/);
});

test('Setup script のテンプレートは marketplace と plugin を install の後に update まで呼ぶ', () => {
  // install は「無ければ入れる」だけで、既に入っていれば marketplace の最新コミットを追わない
  // （2026-09 実測）。install の直後に update を呼び、既存の環境でも最新を取りにいく
  const out = templateCode(apply(tempRepo()).stdout);
  const marketplaceUpdateIdx = out.search(/^\s*claude plugin marketplace update cc-dev-plugins\s*$/m);
  const installIdx = out.search(/claude plugin install "?\$p@cc-dev-plugins"?/);
  assert.ok(marketplaceUpdateIdx > 0 && marketplaceUpdateIdx < installIdx, 'marketplace update が install より前に無い');
  const updates = [...out.matchAll(/^\s*claude plugin update "?\$p@cc-dev-plugins"?\s*$/gm)];
  assert.equal(updates.length, 1);
  const pluginUpdateIdx = out.search(/claude plugin update "?\$p@cc-dev-plugins"?/);
  assert.ok(installIdx < pluginUpdateIdx, 'plugin update が install より前にある');
});

test('Setup script のテンプレートは apt-get update の失敗で後続を止めない', () => {
  // ベースイメージの PPA が 403 で update が非ゼロ終了し、&& でつなぐと install が走らなかった
  const out = templateCode(apply(tempRepo()).stdout);
  assert.doesNotMatch(out, /apt-get update[^\n]*&&/);
  assert.match(out, /apt-get install -y --no-install-recommends gh fonts-noto-cjk/);
});

test('2回実行しても settings.json が変わらない（hook も plugin も重複しない）', () => {
  const dir = tempRepo();
  apply(dir);
  const first = fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8');
  apply(dir);
  assert.equal(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'), first);
  assert.equal(hookEntries(settingsOf(dir)).length, 1);
});

test('既存の設定と、利用者が自分で書いた plugin 宣言はそのまま残す', () => {
  const dir = tempRepo();
  fs.mkdirSync(path.join(dir, '.claude'));
  const existing = {
    permissions: { allow: ['Bash(npm test)'] },
    enabledPlugins: { 'other@elsewhere': true },
    extraKnownMarketplaces: { elsewhere: { source: { source: 'github', repo: 'x/y' } } },
  };
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify(existing));
  apply(dir);
  const s = settingsOf(dir);
  assert.deepEqual(s.permissions, existing.permissions);
  assert.deepEqual(s.enabledPlugins, existing.enabledPlugins);
  assert.deepEqual(s.extraKnownMarketplaces, existing.extraKnownMarketplaces);
});

test('--no-plugins は互換のため受け付けるだけで、結果は同じ', () => {
  const a = tempRepo();
  const b = tempRepo();
  apply(a);
  // 対象ディレクトリの後ろに置いても、ディレクトリとして読み違えない
  const r = spawnSync('bash', [SCRIPT, b, '--no-plugins'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    fs.readFileSync(path.join(a, '.claude', 'settings.json'), 'utf8'),
    fs.readFileSync(path.join(b, '.claude', 'settings.json'), 'utf8'),
  );
});

test('worktree（.git がファイル）でも実行できる', () => {
  const main = tempRepo();
  execFileSync('git', ['-C', main, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init']);
  const wt = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-env-wt-')), 'wt');
  execFileSync('git', ['-C', main, 'worktree', 'add', '-q', wt]);
  apply(wt);
  assert.equal(hookEntries(settingsOf(wt)).length, 1);
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

test('Setup script のテンプレートは日本語のときに Noto Sans CJK JP を先頭にする', () => {
  // fonts-noto-cjk を入れても、プリインストールの中国語フォントが lang=ja で先に選ばれた（2026-09 実測）
  const out = templateCode(apply(tempRepo()).stdout);
  const conf = out.match(/<fontconfig>[\s\S]*?<\/fontconfig>/);
  assert.ok(conf, 'fontconfig の設定が無い');
  assert.match(conf[0], /<test name="lang" compare="contains"><string>ja<\/string><\/test>/);
  assert.match(conf[0], /<edit name="family" mode="prepend" binding="strong"><string>Noto Sans CJK JP<\/string><\/edit>/);
  assert.match(out, /> \/etc\/fonts\/local\.conf/);
  const install = out.indexOf('apt-get install');
  const cache = out.indexOf('fc-cache -f');
  assert.ok(install >= 0 && cache > install, 'フォントを入れた後にキャッシュを作り直していない');
});

test('Setup script のテンプレートは MCP をユーザー単位で登録し、ブラウザまで起動前に用意する', () => {
  // 複数リポジトリのセッションではリポジトリの .mcp.json が効かないので、環境側でユーザー単位に登録する
  const out = templateCode(apply(tempRepo()).stdout);
  for (const [name, pkg] of [['playwright', '@playwright/mcp@'], ['context7', '@upstash/context7-mcp@']]) {
    const add = out.match(new RegExp(`claude mcp add --scope user ${name} -e npm_config_prefer_offline=true -- npx -y (${pkg.replace(/[/@.]/g, '\\$&')}[0-9][^\\s]*)`));
    assert.ok(add, `${name} をユーザー単位で登録していない（名前の後ろに -e を置く）`);
    assert.match(out, new RegExp(`timeout \\d+ npx -y ${add[1].replace(/[/@.]/g, '\\$&')} --version < /dev/null`), `${name} の事前取得の版が登録と違う`);
  }
  assert.match(out, /npx -y @playwright\/mcp@[0-9][^\s]* install-browser chrome-for-testing/);
});

test('playwright MCP は自己署名証明書のリポジトリでも画面を開けるよう証明書エラーを無視する', () => {
  // LB を自前で持つリポジトリ（hrms 等）は自己署名証明書で、ローカルの CA を信頼させる手立てが無い。
  // 付けないと MCP の browser_navigate が ERR_CERT_AUTHORITY_INVALID で失敗する（実測）
  const out = templateCode(apply(tempRepo()).stdout);
  const add = out.match(/claude mcp add --scope user playwright -e npm_config_prefer_offline=true -- npx -y @playwright\/mcp@[^\s]+ ([^\n]*)/);
  assert.ok(add, 'playwright MCP の登録行が見つからない');
  assert.match(add[1], /--ignore-https-errors\b/);
});
