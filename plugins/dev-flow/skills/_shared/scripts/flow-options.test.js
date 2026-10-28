#!/usr/bin/env node
'use strict';

// 要否設定の判定器 flow-options.sh の振る舞いテスト。
// 実行: node --test plugins/dev-flow/skills/_shared/scripts/flow-options.test.js
// origin の既定ブランチの ref 上の docs/dev-flow/flow-options.conf だけを読む。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'flow-options.sh');
const CONF = 'docs/dev-flow/flow-options.conf';
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
};

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, env: GIT_ENV, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} 失敗: ${r.stderr}`);
  return r.stdout;
}

const roots = [];
test.after(() => { for (const d of roots) fs.rmSync(d, { recursive: true, force: true }); });

// origin に conf を持たせた clone を作る。conf が null なら origin には置かない
function repo(conf, workingTreeConf) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-options-'));
  roots.push(d);
  const origin = path.join(d, 'origin.git');
  const seed = path.join(d, 'seed');
  git(d, 'init', '-q', '--bare', '-b', 'main', origin);
  git(d, 'init', '-q', '-b', 'main', seed);
  fs.writeFileSync(path.join(seed, 'README'), 'x');
  if (conf !== null) {
    fs.mkdirSync(path.join(seed, path.dirname(CONF)), { recursive: true });
    fs.writeFileSync(path.join(seed, CONF), conf);
  }
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'init');
  git(seed, 'push', '-q', origin, 'main');
  const clone = path.join(d, 'clone');
  git(d, 'clone', '-q', origin, clone);
  if (workingTreeConf !== undefined) {
    fs.mkdirSync(path.join(clone, path.dirname(CONF)), { recursive: true });
    fs.writeFileSync(path.join(clone, CONF), workingTreeConf);
  }
  return clone;
}

function run(dir) {
  const r = spawnSync('bash', [SCRIPT, '--dir', dir], { env: GIT_ENV, encoding: 'utf8' });
  assert.equal(r.status, 0);
  return JSON.parse(r.stdout.trim());
}

test('設定ファイルが無ければすべて unset で警告なし', () => {
  const j = run(repo(null));
  assert.deepEqual([j.explain_diff, j.test_spec], ['unset', 'unset']);
  assert.deepEqual(j.warnings, []);
});

test('ref 上の on / off を読む。書いていないキーは unset', () => {
  const j = run(repo('# コメント\nexplain_diff=off\n'));
  assert.equal(j.explain_diff, 'off');
  assert.equal(j.test_spec, 'unset');
  assert.match(j.source, /^origin\/main:docs\/dev-flow\/flow-options\.conf$/);
});

test('未マージの宣言は無視して unset、警告を出す', () => {
  const j = run(repo(null, 'test_spec=off\n'));
  assert.equal(j.test_spec, 'unset');
  assert.ok(j.warnings.some((w) => w.includes('未マージ')));
});

test('ref 上の値が優先され、作業ツリーで書き換えても効かない', () => {
  const j = run(repo('test_spec=on\n', 'test_spec=off\n'));
  assert.equal(j.test_spec, 'on');
});

test('不正値と重複はそのキーだけ unset にして警告する', () => {
  const j = run(repo('explain_diff=Off\ntest_spec=on\ntest_spec=off\n'));
  assert.equal(j.explain_diff, 'unset');
  assert.equal(j.test_spec, 'unset');
  assert.equal(j.warnings.length, 2);
});

test('未知のキーは無視して警告する', () => {
  const j = run(repo('qa=off\ntest_spec=on\n'));
  assert.equal(j.test_spec, 'on');
  assert.ok(j.warnings.some((w) => w.includes('未知')));
});

test('--dir 省略・存在しないパス・git 外は unset で exit 0', () => {
  for (const args of [[], ['--dir', '/nonexistent-xyz'], ['--dir', os.tmpdir()]]) {
    const r = spawnSync('bash', [SCRIPT, ...args], { env: GIT_ENV, encoding: 'utf8' });
    assert.equal(r.status, 0);
    const j = JSON.parse(r.stdout.trim());
    assert.equal(j.test_spec, 'unset');
    assert.ok(j.warnings.length >= 1);
  }
});

test('64KiB を超える設定ファイルは読まずに unset', () => {
  const j = run(repo('test_spec=on\n' + '#'.repeat(70000) + '\n'));
  assert.equal(j.test_spec, 'unset');
  assert.ok(j.warnings.some((w) => w.includes('大きすぎる')));
});
