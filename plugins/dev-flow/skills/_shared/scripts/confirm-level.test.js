#!/usr/bin/env node
'use strict';

// 確認レベル判定器 confirm-level.sh の振る舞いテスト。
// 実行: node --test plugins/dev-flow/skills/_shared/scripts/confirm-level.test.js
//
// 判定器は「ローカルにある origin 既定ブランチの ref」上の docs/dev-flow/confirm-level.conf だけを読む。
// 作業ツリーの light 宣言を有効にすると、作業中の変更で自分の確認を緩められてしまうため。
// 各テストは bare の origin と clone を一時ディレクトリに組み立てる（ネットワークは使わない）。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'confirm-level.sh');
const CONF = 'docs/dev-flow/confirm-level.conf';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, env: GIT_ENV, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} 失敗: ${r.stderr}`);
  return r.stdout;
}

const roots = [];
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-level-'));
  roots.push(d);
  return fs.realpathSync(d);
}
test.after(() => {
  for (const d of roots) fs.rmSync(d, { recursive: true, force: true });
});

function writeConf(repo, content) {
  const f = path.join(repo, CONF);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
}

// bare origin を作り、指定ブランチ群へ内容を push する。files: { ブランチ名: 設定ファイル内容 | null }
// head: origin の HEAD が指すブランチ（clone 時に origin/HEAD になる）
function makeOrigin(files, head) {
  const root = tmp();
  const origin = path.join(root, 'origin.git');
  git(root, 'init', '--bare', '-b', head, origin);
  const seed = path.join(root, 'seed');
  git(root, 'init', '-b', head, seed);
  fs.writeFileSync(path.join(seed, 'README.md'), 'seed\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-m', 'init');
  git(seed, 'remote', 'add', 'origin', origin);
  for (const [branch, content] of Object.entries(files)) {
    git(seed, 'checkout', '-B', branch, head);
    if (content !== null) {
      writeConf(seed, content);
      git(seed, 'add', '.');
      git(seed, 'commit', '-m', `conf on ${branch}`);
    }
    git(seed, 'push', 'origin', branch);
  }
  return { root, origin };
}

function cloneOf({ root, origin }) {
  const work = path.join(root, 'work');
  git(root, 'clone', origin, work);
  return work;
}

// 典型形: origin の main に設定ファイル（null なら無し）を置いた clone
function scenario(originConf, head = 'main') {
  return cloneOf(makeOrigin({ [head]: originConf }, head));
}

function run(args) {
  const r = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8' });
  return r;
}

// 全ケース共通: exit 0、stdout はちょうど 1 行の JSON、形が仕様どおり
function judge(args) {
  const r = run(args);
  assert.equal(r.status, 0, `exit 0 のはず: status=${r.status} stderr=${r.stderr}`);
  const lines = r.stdout.split('\n').filter((l, i, a) => !(i === a.length - 1 && l === ''));
  assert.equal(lines.length, 1, `stdout は 1 行のはず: ${JSON.stringify(r.stdout)}`);
  const j = JSON.parse(lines[0]);
  assert.ok(['strict', 'light'].includes(j.level), `level が不正: ${j.level}`);
  assert.equal(typeof j.source, 'string');
  assert.equal(typeof j.file, 'string');
  assert.ok(Array.isArray(j.warnings));
  for (const w of j.warnings) assert.equal(typeof w, 'string');
  return j;
}

const judgeDir = (dir) => judge(['--dir', dir]);
const warned = (j, part) => j.warnings.some((w) => w.includes(part));

// ---- E1 / E2: 設定なし・origin 上の宣言 ----

test('AC1: 設定ファイルが無ければ strict・source default・file 空・警告なし', () => {
  const j = judgeDir(scenario(null));
  assert.deepEqual(j, { level: 'strict', source: 'default', file: '', warnings: [] });
});

test('AC2: origin の main に light があれば light と判定し、出所を origin/main:パスで返す', () => {
  const j = judgeDir(scenario('confirm_level=light\n'));
  assert.equal(j.level, 'light');
  assert.equal(j.source, `origin/main:${CONF}`);
  assert.equal(j.file, CONF);
  assert.deepEqual(j.warnings, []);
});

test('AC2b: origin の main が明示的な strict なら strict・出所は読んだファイル・警告なし', () => {
  const j = judgeDir(scenario('confirm_level=strict\n'));
  assert.equal(j.level, 'strict');
  assert.equal(j.source, `origin/main:${CONF}`);
  assert.equal(j.file, CONF);
  assert.deepEqual(j.warnings, []);
});

test('AC2c: ref 上が light なら作業ツリーが strict でも light（作業ツリーは見ない・警告なし）', () => {
  const work = scenario('confirm_level=light\n');
  writeConf(work, 'confirm_level=strict\n');
  const j = judgeDir(work);
  assert.equal(j.level, 'light');
  assert.deepEqual(j.warnings, []);
});

test('AC2d: ref 上が light なら作業ツリーのファイルを消しても light', () => {
  const work = scenario('confirm_level=light\n');
  fs.rmSync(path.join(work, CONF));
  const j = judgeDir(work);
  assert.equal(j.level, 'light');
  assert.deepEqual(j.warnings, []);
});

// ---- E3: 自己緩和の防止 ----

test('AC3: 作業ツリーの未コミット light 宣言は無視され strict のまま（ref が strict）', () => {
  const work = scenario('confirm_level=strict\n');
  writeConf(work, 'confirm_level=light\n');
  const j = judgeDir(work);
  assert.equal(j.level, 'strict');
  assert.ok(warned(j, '未マージの light 宣言は無視'), JSON.stringify(j.warnings));
});

test('AC3b: 作業ブランチにコミット済みの light 宣言も無視される', () => {
  const work = scenario('confirm_level=strict\n');
  git(work, 'checkout', '-b', 'feat/x');
  writeConf(work, 'confirm_level=light\n');
  git(work, 'add', '.');
  git(work, 'commit', '-m', 'relax');
  const j = judgeDir(work);
  assert.equal(j.level, 'strict');
  assert.ok(warned(j, '未マージの light 宣言は無視'), JSON.stringify(j.warnings));
});

test('AC3c: origin にファイル自体が無く作業ツリーが light でも strict + 無視の警告', () => {
  const work = scenario(null);
  writeConf(work, 'confirm_level=light\n');
  const j = judgeDir(work);
  assert.equal(j.level, 'strict');
  assert.equal(j.source, 'default');
  assert.ok(warned(j, '未マージの light 宣言は無視'), JSON.stringify(j.warnings));
});

test('AC3d: 作業ツリーが strict で ref が無し・strict なら警告なし', () => {
  const work = scenario(null);
  writeConf(work, 'confirm_level=strict\n');
  const j = judgeDir(work);
  assert.equal(j.level, 'strict');
  assert.ok(!warned(j, '未マージ'), JSON.stringify(j.warnings));
});

// ---- E4: 設定ファイルの規則 ----

for (const [name, content] of [
  ['先頭大文字 Light', 'confirm_level=Light\n'],
  ['未定義の medium', 'confirm_level=medium\n'],
  ['空値', 'confirm_level=\n'],
  ['行末コメント付き', 'confirm_level=light # メモ\n'],
]) {
  test(`AC4: 不正値（${name}）は strict + 不正値の警告、出所は読んだファイル`, () => {
    const j = judgeDir(scenario(content));
    assert.equal(j.level, 'strict');
    assert.ok(warned(j, '不正値'), JSON.stringify(j.warnings));
    assert.equal(j.source, `origin/main:${CONF}`);
    assert.equal(j.file, CONF);
  });
}

test('AC4b: confirm_level が重複したら strict + 不正値 + キーの重複（先に light でも後に light でも）', () => {
  for (const content of ['confirm_level=light\nconfirm_level=strict\n', 'confirm_level=strict\nconfirm_level=light\n', 'confirm_level=light\nconfirm_level=light\n']) {
    const j = judgeDir(scenario(content));
    assert.equal(j.level, 'strict', content);
    assert.ok(warned(j, '不正値'), JSON.stringify(j.warnings));
    assert.ok(warned(j, 'キーの重複'), JSON.stringify(j.warnings));
  }
});

test('AC4c: ファイルはあるが confirm_level の指定が無い（空ファイル・コメントだけ）は strict + 指定が無い', () => {
  for (const content of ['', '# コメントだけ\n\n', '\n']) {
    const j = judgeDir(scenario(content));
    assert.equal(j.level, 'strict', JSON.stringify(content));
    assert.ok(warned(j, '指定が無い'), JSON.stringify(j.warnings));
    assert.equal(j.source, `origin/main:${CONF}`);
    assert.equal(j.file, CONF);
  }
});

test('AC4d: 未知のキーは無視して警告し、レベルは confirm_level の値どおり（light / strict 両方）', () => {
  const l = judgeDir(scenario('foo=bar\nconfirm_level=light\n'));
  assert.equal(l.level, 'light');
  assert.ok(warned(l, '未知のキー'), JSON.stringify(l.warnings));
  const s = judgeDir(scenario('confirm_level=strict\nfoo=bar\n'));
  assert.equal(s.level, 'strict');
  assert.ok(warned(s, '未知のキー'), JSON.stringify(s.warnings));
});

test('AC4e: 空行・# コメント・キーと値の前後の空白は許容される（light）', () => {
  const j = judgeDir(scenario('# 説明\n\n   confirm_level = light  \n'));
  assert.equal(j.level, 'light');
  assert.deepEqual(j.warnings, []);
});

test('AC4f: CRLF 改行でも light と読める', () => {
  const j = judgeDir(scenario('# メモ\r\nconfirm_level=light\r\n'));
  assert.equal(j.level, 'light');
  assert.deepEqual(j.warnings, []);
});

test('AC4g: 空白入りの不正値 "light x" は不正値で strict', () => {
  const j = judgeDir(scenario('confirm_level = light x\n'));
  assert.equal(j.level, 'strict');
  assert.ok(warned(j, '不正値'), JSON.stringify(j.warnings));
});

// ---- E5: ref の決め方 ----

test('AC5: origin が無い（git init しただけ）は strict・source default・確認できない', () => {
  const dir = tmp();
  git(dir, 'init', '-b', 'main', dir);
  writeConf(dir, 'confirm_level=light\n');
  const j = judgeDir(dir);
  assert.equal(j.level, 'strict');
  assert.equal(j.source, 'default');
  assert.ok(warned(j, '確認できない'), JSON.stringify(j.warnings));
});

test('AC5b: origin の既定ブランチが trunk なら origin/trunk の light を読む', () => {
  const j = judgeDir(scenario('confirm_level=light\n', 'trunk'));
  assert.equal(j.level, 'light');
  assert.equal(j.source, `origin/trunk:${CONF}`);
  assert.deepEqual(j.warnings, []);
});

test('AC5c: origin/HEAD が指す trunk を、origin/main より優先する', () => {
  // trunk は light、main は strict。main を読む実装は strict を返して落ちる。
  const j = judgeDir(cloneOf(makeOrigin({ main: 'confirm_level=strict\n', trunk: 'confirm_level=light\n' }, 'trunk')));
  assert.equal(j.level, 'light');
  assert.equal(j.source, `origin/trunk:${CONF}`);
});

test('AC5d: origin/HEAD が無く origin/master だけがあれば master を読む', () => {
  const work = scenario('confirm_level=light\n', 'master');
  git(work, 'symbolic-ref', '-d', 'refs/remotes/origin/HEAD');
  const j = judgeDir(work);
  assert.equal(j.level, 'light');
  assert.equal(j.source, `origin/master:${CONF}`);
});

test('AC5e: origin/HEAD が無く main と master が両方あれば main を優先する', () => {
  const work = cloneOf(makeOrigin({ main: 'confirm_level=light\n', master: 'confirm_level=strict\n' }, 'main'));
  git(work, 'symbolic-ref', '-d', 'refs/remotes/origin/HEAD');
  const j = judgeDir(work);
  assert.equal(j.level, 'light');
  assert.equal(j.source, `origin/main:${CONF}`);
});

test('AC5f: origin はあるが main / master / origin/HEAD がどれも解決できなければ strict + 確認できない', () => {
  const work = scenario('confirm_level=light\n', 'develop');
  git(work, 'symbolic-ref', '-d', 'refs/remotes/origin/HEAD');
  const j = judgeDir(work);
  assert.equal(j.level, 'strict');
  assert.equal(j.source, 'default');
  assert.ok(warned(j, '確認できない'), JSON.stringify(j.warnings));
});

// ---- 引数エラー ----

test('AC6: --dir 省略は strict + --dir の警告で exit 0', () => {
  const j = judge([]);
  assert.equal(j.level, 'strict');
  assert.equal(j.source, 'default');
  assert.ok(warned(j, '--dir'), JSON.stringify(j.warnings));
});

test('AC6b: --dir が空文字は strict + --dir の警告', () => {
  const j = judge(['--dir', '']);
  assert.equal(j.level, 'strict');
  assert.ok(warned(j, '--dir'), JSON.stringify(j.warnings));
});

test('AC6c: --dir が値なしで終わっても strict + --dir の警告', () => {
  const j = judge(['--dir']);
  assert.equal(j.level, 'strict');
  assert.ok(warned(j, '--dir'), JSON.stringify(j.warnings));
});

test('AC6d: 存在しないパスは strict + --dir の警告', () => {
  const j = judgeDir(path.join(tmp(), 'no-such-dir'));
  assert.equal(j.level, 'strict');
  assert.equal(j.source, 'default');
  assert.ok(warned(j, '--dir'), JSON.stringify(j.warnings));
});

test('AC6e: git リポジトリでないディレクトリは strict + --dir + git リポジトリではない', () => {
  const dir = tmp();
  writeConf(dir, 'confirm_level=light\n');
  const j = judgeDir(dir);
  assert.equal(j.level, 'strict');
  assert.equal(j.source, 'default');
  assert.ok(warned(j, '--dir'), JSON.stringify(j.warnings));
  assert.ok(warned(j, 'git リポジトリではない'), JSON.stringify(j.warnings));
});

// ---- E7: サブディレクトリ・worktree ----

test('AC7: リポジトリのサブディレクトリを渡しても、ルートの origin 設定を読む（light）', () => {
  const work = scenario('confirm_level=light\n');
  fs.mkdirSync(path.join(work, 'src', 'deep'), { recursive: true });
  const j = judgeDir(path.join(work, 'src', 'deep'));
  assert.equal(j.level, 'light');
  assert.equal(j.source, `origin/main:${CONF}`);
});

test('AC7b: サブディレクトリから渡しても、ルートの作業ツリーの未マージ宣言は無視される', () => {
  const work = scenario('confirm_level=strict\n');
  writeConf(work, 'confirm_level=light\n');
  fs.mkdirSync(path.join(work, 'src'), { recursive: true });
  const j = judgeDir(path.join(work, 'src'));
  assert.equal(j.level, 'strict');
  assert.ok(warned(j, '未マージの light 宣言は無視'), JSON.stringify(j.warnings));
});

test('AC7c: git worktree のパスを渡しても origin の light を読む', () => {
  const work = scenario('confirm_level=light\n');
  const wt = path.join(path.dirname(work), 'wt');
  git(work, 'worktree', 'add', '-b', 'feat/wt', wt);
  const j = judgeDir(wt);
  assert.equal(j.level, 'light');
  assert.equal(j.source, `origin/main:${CONF}`);
});

test('AC7d: worktree 側で書いた未マージの light 宣言は無視される', () => {
  const work = scenario('confirm_level=strict\n');
  const wt = path.join(path.dirname(work), 'wt');
  git(work, 'worktree', 'add', '-b', 'feat/wt', wt);
  writeConf(wt, 'confirm_level=light\n');
  const j = judgeDir(wt);
  assert.equal(j.level, 'strict');
  assert.ok(warned(j, '未マージの light 宣言は無視'), JSON.stringify(j.warnings));
});
