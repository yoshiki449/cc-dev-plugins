#!/usr/bin/env node
'use strict';

// ensure-worktree.sh のテスト。
// 実行: node --test plugins/dev-flow/skills/_shared/scripts/ensure-worktree.test.js
//
// 動機: git-flow 運用（既定ブランチが develop）のリポで、既定ブランチ上にいても
// `on_main_branch`（= ブランチを切って worktree へ、の合図）に分類されず `flat_repo`
// （= 現在のブランチをそのまま worktree 化してもよい、の合図）に落ちていた。結果として
// dev-setup を通しても develop 上でそのまま作業・push される経路が残っていた。
// 判定は main/master だけでなく (1) `origin/HEAD` symbolic-ref で検出した既定ブランチ
// (2) それが取れない場合のフォールバック候補（main/master/develop）のどちらかに
// 一致すれば「ベースブランチ上」として扱う。

const test = require('node:test');
const assert = require('node:assert');
const { spawnSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.join(__dirname, 'ensure-worktree.sh');

// 実行環境（開発者の ~/.gitconfig 等）から隔離する。assess-change-size.test.js と同じ理由。
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

const NEUTRAL_CWD = os.tmpdir();

function git(dir, args) {
  return execFileSync('git', args, { cwd: dir, env: GIT_ENV, encoding: 'utf8' });
}

function makeTmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensure-worktree-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// <tmp>/repo に、指定ブランチで初期コミット済みの repo を作る（project-folder/repo/ 規約）。
function makeRepoClone(t, branch) {
  const projectFolder = makeTmpDir(t);
  const repoDir = path.join(projectFolder, 'repo');
  fs.mkdirSync(repoDir);
  git(repoDir, ['init', '-q', '-b', branch]);
  git(repoDir, ['config', 'user.name', 'Test User']);
  git(repoDir, ['config', 'user.email', 'test@example.com']);
  git(repoDir, ['commit', '-q', '--allow-empty', '-m', 'init']);
  return { projectFolder, repoDir };
}

// CLAUDE_CODE_REMOTE を明示する。クラウド上でテストを回すと継承した true で
// 既存の flat_repo 判定が cloud_clone に変わって落ちるため。
function runScript(dir, remote = 'false') {
  return spawnSync('bash', [SCRIPT, '--json', dir], {
    encoding: 'utf8',
    env: { ...GIT_ENV, CLAUDE_CODE_REMOTE: remote },
    cwd: NEUTRAL_CWD,
  });
}

function parseJsonOutput(res) {
  const lines = res.stdout.trim().split('\n');
  assert.equal(lines.length, 1, `stdout は JSON 1行のみを期待: ${JSON.stringify(res.stdout)}`);
  return JSON.parse(lines[0]);
}

// --- 既定ブランチ判定（フォールバック候補: main/master/develop） -----------------

test('main ブランチの main clone は on_main_branch（回帰）', (t) => {
  const { repoDir } = makeRepoClone(t, 'main');
  const res = runScript(repoDir);
  assert.equal(res.status, 1);
  const out = parseJsonOutput(res);
  assert.equal(out.status, 'on_main_branch');
  assert.equal(out.branch, 'main');
});

test('develop ブランチ（origin/HEAD 未設定）の main clone は on_main_branch', (t) => {
  const { repoDir } = makeRepoClone(t, 'develop');
  const res = runScript(repoDir);
  assert.equal(res.status, 1);
  const out = parseJsonOutput(res);
  assert.equal(
    out.status,
    'on_main_branch',
    'develop はフォールバック候補に含まれるため on_main_branch になるべき（flat_repo に落ちるとブランチを切らず develop 上で作業してよいと誤解する）'
  );
  assert.equal(out.branch, 'develop');
});

test('ベースブランチ候補に無い未知のブランチ名（origin 無し）は flat_repo のまま', (t) => {
  const { repoDir } = makeRepoClone(t, 'staging');
  const res = runScript(repoDir);
  assert.equal(res.status, 1);
  const out = parseJsonOutput(res);
  assert.equal(out.status, 'flat_repo');
  assert.equal(out.branch, 'staging');
});

// --- 既定ブランチ判定（origin/HEAD による動的検出） ------------------------------

test('origin/HEAD が指す既定ブランチ（main/master/developでもない名前）は on_main_branch', (t) => {
  const projectFolder = makeTmpDir(t);
  const bareDir = path.join(projectFolder, 'origin.git');
  fs.mkdirSync(bareDir);
  git(bareDir, ['init', '-q', '--bare', '-b', 'trunk']);

  const repoDir = path.join(projectFolder, 'repo');
  fs.mkdirSync(repoDir);
  git(repoDir, ['init', '-q', '-b', 'trunk']);
  git(repoDir, ['config', 'user.name', 'Test User']);
  git(repoDir, ['config', 'user.email', 'test@example.com']);
  git(repoDir, ['commit', '-q', '--allow-empty', '-m', 'init']);
  git(repoDir, ['remote', 'add', 'origin', bareDir]);
  git(repoDir, ['push', '-q', 'origin', 'trunk']);
  git(repoDir, ['remote', 'set-head', 'origin', '-a']);

  const res = runScript(repoDir);
  assert.equal(res.status, 1);
  const out = parseJsonOutput(res);
  assert.equal(out.status, 'on_main_branch');
  assert.equal(out.branch, 'trunk');
});

test('origin/HEAD が develop を指す場合、develop 以外のブランチは on_main_branch にならない', (t) => {
  const projectFolder = makeTmpDir(t);
  const bareDir = path.join(projectFolder, 'origin.git');
  fs.mkdirSync(bareDir);
  git(bareDir, ['init', '-q', '--bare', '-b', 'develop']);

  const repoDir = path.join(projectFolder, 'repo');
  fs.mkdirSync(repoDir);
  git(repoDir, ['init', '-q', '-b', 'develop']);
  git(repoDir, ['config', 'user.name', 'Test User']);
  git(repoDir, ['config', 'user.email', 'test@example.com']);
  git(repoDir, ['commit', '-q', '--allow-empty', '-m', 'init']);
  git(repoDir, ['remote', 'add', 'origin', bareDir]);
  git(repoDir, ['push', '-q', 'origin', 'develop']);
  git(repoDir, ['remote', 'set-head', 'origin', '-a']);
  git(repoDir, ['checkout', '-q', '-b', 'feature/foo']);

  const res = runScript(repoDir);
  assert.equal(res.status, 1);
  const out = parseJsonOutput(res);
  assert.equal(out.status, 'flat_repo');
  assert.equal(out.branch, 'feature/foo');
});

// --- クラウドセッション（単一 clone）-------------------------------------------

// クラウドの clone は <任意>/<リポジトリ名> に置かれ、repo/ + worktrees/ 構成ではない。
function makeFlatClone(t, branch) {
  const dir = path.join(makeTmpDir(t), 'my-app');
  fs.mkdirSync(dir);
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.name', 'Test User']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['commit', '-q', '--allow-empty', '-m', 'init']);
  if (branch !== 'main') git(dir, ['checkout', '-q', '-b', branch]);
  return dir;
}

test('クラウド: 非ベースブランチのフラット clone は cloud_clone で exit 0（worktree を要求しない）', (t) => {
  const dir = makeFlatClone(t, 'claude/tender-mccarthy-ccehem');
  const res = runScript(dir, 'true');
  assert.equal(res.status, 0);
  const out = parseJsonOutput(res);
  assert.equal(out.status, 'cloud_clone');
  assert.equal(out.branch, 'claude/tender-mccarthy-ccehem');
  assert.equal(out.worktree_dir, '', 'worktree は作らないので空');
});

test('クラウド: 同じ clone でもローカルなら flat_repo のまま', (t) => {
  const dir = makeFlatClone(t, 'claude/tender-mccarthy-ccehem');
  const res = runScript(dir, 'false');
  assert.equal(res.status, 1);
  assert.equal(parseJsonOutput(res).status, 'flat_repo');
});

test('クラウド: ベースブランチ上は on_main_branch のまま（main 誤コミットの防止は維持）', (t) => {
  const dir = makeFlatClone(t, 'main');
  const res = runScript(dir, 'true');
  assert.equal(res.status, 1);
  assert.equal(parseJsonOutput(res).status, 'on_main_branch');
});

test('クラウド: CLAUDE_CODE_REMOTE が true 以外の値なら cloud_clone にしない', (t) => {
  const dir = makeFlatClone(t, 'feature/foo');
  const res = runScript(dir, '1');
  assert.equal(parseJsonOutput(res).status, 'flat_repo');
});
