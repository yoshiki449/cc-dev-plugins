#!/usr/bin/env node
'use strict';

// secret-scan.sh の誤検出対策のテスト。
// 実行: node --test plugins/git-secret-guard/scripts/secret-scan.test.js
//
// 実測でユーザーから報告された誤検出（PASSWORD/TOKEN 等の変数代入バケット）:
//   - テスト用のダミー値・フィクスチャ
//   - ハッシュ化済みの値（bcrypt 等）
//   - 設定ファイルのプレースホルダ的キー名（大文字小文字違いで除外語に一致しない）
//   - 変数名に TOKEN/SECRET を含むが値は無害
//
// 誤検出を減らす方向は真の検出を弱めるのと表裏なので、既存の検出（本物のトークン
// prefix・非テストファイルでの明白な秘密）が消えていないことも同じ重みで固定する。

const test = require('node:test');
const assert = require('node:assert');
const { spawnSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.join(__dirname, 'secret-scan.sh');

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

let seq = 0;
function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `secret-scan-${tag}-${seq++}-`));
}

// upstream の無い新規リポジトリを作り、直近1コミットに files を積む。
// secret-scan.sh は upstream が無いと `git log -p --max-count=1`（HEAD range）を見るので、
// これが一番セットアップの軽い経路になる。
function mkRepo(files) {
  const dir = tmpdir('repo');
  execFileSync('git', ['init', '-q'], { cwd: dir, env: GIT_ENV });
  for (const [name, body] of Object.entries(files)) {
    const abs = path.join(dir, name);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  execFileSync('git', ['add', '-A'], { cwd: dir, env: GIT_ENV });
  execFileSync(
    'git',
    ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'init'],
    { cwd: dir, env: GIT_ENV },
  );
  return dir;
}

function run(cwd) {
  return spawnSync('bash', [SCRIPT], { encoding: 'utf8', cwd, env: GIT_ENV });
}

// ---------------------------------------------------------------------------
// 真の検出は消えていないこと（回帰）
// ---------------------------------------------------------------------------

test('本物のトークン prefix は非テストファイルで検出する', () => {
  const repo = mkRepo({ 'conf.py': `TOKEN = "ghp_${'A'.repeat(36)}"\n` });
  const r = run(repo);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /SaaS\/Cloud トークン形式/);
});

test('本物のトークン prefix はテストファイルでも検出する（パターン1はテスト除外の対象外）', () => {
  const repo = mkRepo({ 'tests/conf.test.py': `TOKEN = "ghp_${'A'.repeat(36)}"\n` });
  const r = run(repo);
  assert.strictEqual(r.status, 1, 'テストファイルだからといって本物のトークンを見逃してはいけない');
  assert.match(r.stderr, /SaaS\/Cloud トークン形式/);
});

test('非テストファイルの明白な PASSWORD 直書きは引き続き検出する', () => {
  const repo = mkRepo({ 'settings.py': 'PASSWORD = "Tr0ub4dor&3xyzZQ"\n' });
  const r = run(repo);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /PASSWORD\/API_TOKEN 等の変数代入/);
});

test('非テストファイルの本物らしい40文字以上の英数字は引き続き検出する', () => {
  const repo = mkRepo({ 'blob.txt': `payload = "${'a1B2c3D4'.repeat(6)}"\n` });
  const r = run(repo);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /40文字以上の長い英数字/);
});

// ---------------------------------------------------------------------------
// 誤検出の修正: テスト/フィクスチャファイルの変数代入・長い英数字
// ---------------------------------------------------------------------------

for (const p of [
  'tests/fixtures/user.js',
  'src/__tests__/auth.js',
  '__mocks__/api.js',
  'spec/user_spec.rb',
  'app/auth.test.ts',
  'app/auth_test.py',
  'testdata/config.yaml',
]) {
  test(`テスト/フィクスチャファイル(${p})のダミー PASSWORD/TOKEN 代入は誤検出しない`, () => {
    const repo = mkRepo({ [p]: 'PASSWORD = "Tr0ub4dor&3xyzZQ"\nTOKEN = "abcdefghijklmnop12345678"\n' });
    const r = run(repo);
    assert.strictEqual(r.status, 0, `テストファイルのダミー値まで止めてはいけない\n${r.stderr}`);
  });

  test(`テスト/フィクスチャファイル(${p})の長い英数字は誤検出しない`, () => {
    const repo = mkRepo({ [p]: `const blob = "${'a1B2c3D4'.repeat(6)}";\n` });
    const r = run(repo);
    assert.strictEqual(r.status, 0, `テストファイルの長い英数字まで止めてはいけない\n${r.stderr}`);
  });
}

test('ファイル名に test を含むだけ（ディレクトリ/拡張子で区切られない）は誤って除外しない', () => {
  // "contest.py" は "test" を部分文字列に含むが、テストファイルではない。
  // 除外がここまで広がると本物の値を見逃す。
  const repo = mkRepo({ 'contest.py': 'PASSWORD = "Tr0ub4dor&3xyzZQ"\n' });
  const r = run(repo);
  assert.strictEqual(r.status, 1, '"contest.py" のようなファイルまでテスト扱いで除外してはいけない');
});

// ---------------------------------------------------------------------------
// 誤検出の修正: 大文字小文字違いのプレースホルダ表記
// ---------------------------------------------------------------------------

const CASE_VARIANT_PLACEHOLDERS = [
  'API_TOKEN = "Fake1234567890ABCDEF"',
  'SECRET = "REPLACE-WITH-your-own-value"',
  'PASSWORD = "PLACEHOLDER12345678"',
  'API_KEY = "XXXXXXXXXXXXXXXXXXXX"',
  'TOKEN = "REDACTED1234567890AB"',
];

for (const line of CASE_VARIANT_PLACEHOLDERS) {
  test(`大文字小文字違いのプレースホルダは誤検出しない: ${line}`, () => {
    const repo = mkRepo({ 'settings.py': line + '\n' });
    const r = run(repo);
    assert.strictEqual(r.status, 0, `表記違いのプレースホルダを弾いてしまった\n${r.stderr}`);
  });
}

// ---------------------------------------------------------------------------
// 誤検出の修正: ハッシュ化済みの値
// ---------------------------------------------------------------------------

test('bcrypt 形式のハッシュ化済みパスワードは誤検出しない', () => {
  const repo = mkRepo({
    'settings.py': 'PASSWORD_HASH = "$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy"\n',
  });
  const r = run(repo);
  assert.strictEqual(r.status, 0, `ハッシュ化済みの値を秘密の値として止めてしまった\n${r.stderr}`);
});

test('変数名に hash を含む代入は誤検出しない', () => {
  const repo = mkRepo({ 'settings.py': 'API_TOKEN_HASH = "abcdefghijklmnopqrstuvwxyz123456"\n' });
  const r = run(repo);
  assert.strictEqual(r.status, 0, `hash 由来の変数名を秘密の値として止めてしまった\n${r.stderr}`);
});
