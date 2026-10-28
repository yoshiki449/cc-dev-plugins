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

// ---- 敵対的検証（1 周目）の指摘を固定する ----

// stdout を厳密に検査する版。opts: { env, shellPath(Buffer 的な printf 式) }
function judgeX(args, opts = {}) {
  const r = spawnSync('bash', [SCRIPT, ...args], { encoding: 'buffer', env: opts.env || process.env });
  return parseStrict(r);
}
function parseStrict(r) {
  assert.equal(r.status, 0, `exit 0 のはず: status=${r.status} stderr=${r.stderr}`);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(r.stdout);
  const lines = text.split('\n').filter((l, i, a) => !(i === a.length - 1 && l === ''));
  assert.equal(lines.length, 1, `stdout は 1 行のはず: ${JSON.stringify(text)}`);
  const j = JSON.parse(lines[0]);
  assert.ok(['strict', 'light'].includes(j.level), `level が不正: ${j.level}`);
  assert.ok(Array.isArray(j.warnings));
  return j;
}
const allWarn = (j) => j.warnings.join('\n');

// 現在のブランチを離れずに、light 宣言を含むコミットを作って SHA を返す
function lightCommit(work) {
  const cur = git(work, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
  git(work, 'checkout', '-q', '-b', 'tmp-light-src');
  writeConf(work, 'confirm_level=light\n');
  git(work, 'add', '.');
  git(work, 'commit', '-m', 'light source');
  const sha = git(work, 'rev-parse', 'HEAD').trim();
  git(work, 'checkout', '-q', cur);
  git(work, 'branch', '-D', 'tmp-light-src');
  return sha;
}

test('C1: 同名のタグ origin/main で ref を上書きしても strict のまま', () => {
  const work = scenario('confirm_level=strict\n');
  git(work, 'tag', 'origin/main', lightCommit(work));
  const j = judgeDir(work);
  assert.equal(j.level, 'strict');
});

test('C1b: 同名のローカルブランチ origin/main で ref を上書きしても strict のまま', () => {
  const work = scenario('confirm_level=strict\n');
  git(work, 'branch', 'origin/main', lightCommit(work));
  const j = judgeDir(work);
  assert.equal(j.level, 'strict');
});

const lightRepoEnvs = (light) => ({
  GIT_DIR: path.join(light, '.git'),
  GIT_WORK_TREE: light,
  GIT_INDEX_FILE: path.join(light, '.git', 'index'),
  GIT_COMMON_DIR: path.join(light, '.git'),
  GIT_OBJECT_DIRECTORY: path.join(light, '.git', 'objects'),
  GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(light, '.git', 'objects'),
  GIT_NAMESPACE: 'foo',
});

for (const key of Object.keys(lightRepoEnvs('/x'))) {
  test(`C2: 環境変数 ${key} が light リポジトリを指していても --dir の strict リポジトリで判定する`, () => {
    const light = scenario('confirm_level=light\n');
    const strict = scenario('confirm_level=strict\n');
    const j = judgeX(['--dir', strict], { env: { ...process.env, [key]: lightRepoEnvs(light)[key] } });
    assert.equal(j.level, 'strict', JSON.stringify(j));
  });
}

test('C2b: GIT_DIR だけが light リポジトリを指し --dir が非 git ディレクトリでも strict + git リポジトリではない', () => {
  const light = scenario('confirm_level=light\n');
  const dir = tmp();
  const j = judgeX(['--dir', dir], { env: { ...process.env, GIT_DIR: path.join(light, '.git') } });
  assert.equal(j.level, 'strict');
  assert.ok(warned(j, 'git リポジトリではない'), JSON.stringify(j.warnings));
});

test('C3: git replace で origin/main のコミットを light に差し替えても strict のまま', () => {
  const work = scenario('confirm_level=strict\n');
  const target = git(work, 'rev-parse', 'refs/remotes/origin/main').trim();
  git(work, 'replace', target, lightCommit(work));
  const j = judgeDir(work);
  assert.equal(j.level, 'strict');
});

test('C4: 非 UTF-8 バイトを含む存在しないパスでも、1 行の有効な UTF-8 JSON で strict + --dir', () => {
  const r = spawnSync('bash', ['-c', 'bash "$0" --dir "$(printf "/nonexistent-\\377\\376/x")"', SCRIPT], { encoding: 'buffer' });
  const j = parseStrict(r);
  assert.equal(j.level, 'strict');
  assert.ok(warned(j, '--dir'), JSON.stringify(j.warnings));
});

test('C4b: ダブルクォート・バックスラッシュ・タブを含むパスが警告にそのまま含まれる', () => {
  const p = path.join(tmp(), 'a"b\\c\td');
  const j = judgeX(['--dir', p]);
  assert.equal(j.level, 'strict');
  assert.ok(j.warnings.some((w) => w.includes(p)), JSON.stringify(j.warnings));
});

// ---- 最終行が改行なしの設定 ----

test('M-nl1: ref 上の confirm_level=light（末尾改行なし）は light', () => {
  const j = judgeDir(scenario('confirm_level=light'));
  assert.equal(j.level, 'light');
  assert.deepEqual(j.warnings, []);
});

test('M-nl2: 未知のキーの後ろの confirm_level=light（末尾改行なし）は light + 未知のキー', () => {
  const j = judgeDir(scenario('foo=1\nconfirm_level=light'));
  assert.equal(j.level, 'light');
  assert.ok(warned(j, '未知のキー'), JSON.stringify(j.warnings));
});

test('M-nl3: 作業ツリーの confirm_level=light（末尾改行なし）も未マージの light 宣言として無視される', () => {
  const work = scenario('confirm_level=strict\n');
  writeConf(work, 'confirm_level=light');
  const j = judgeDir(work);
  assert.equal(j.level, 'strict');
  assert.ok(warned(j, '未マージの light 宣言は無視'), JSON.stringify(j.warnings));
});

// ---- origin/HEAD が解決できない ref を指す ----

test('M1: origin/HEAD が存在しない origin/trunk を指すとき、origin/main で判定し origin/HEAD と代用を警告する', () => {
  const work = scenario('confirm_level=light\n');
  git(work, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
  const j = judgeDir(work);
  assert.equal(j.level, 'light');
  assert.equal(j.source, `origin/main:${CONF}`);
  assert.ok(warned(j, 'origin/HEAD') || allWarn(j).includes('origin/HEAD'), JSON.stringify(j.warnings));
  assert.ok(allWarn(j).includes('代用'), JSON.stringify(j.warnings));
});

// ---- 設定ファイルの大きさ ----

function sizedConf(head, bytes) {
  const pad = bytes - Buffer.byteLength(head);
  assert.ok(pad >= 2);
  return head + '#' + 'x'.repeat(pad - 2) + '\n';
}

test('M2: ちょうど 65536 バイトの設定は通常どおり読む（light・警告なし）', () => {
  const content = sizedConf('confirm_level=light\n', 65536);
  assert.equal(Buffer.byteLength(content), 65536);
  const j = judgeDir(scenario(content));
  assert.equal(j.level, 'light');
  assert.deepEqual(j.warnings, []);
});

test('M2b: 65537 バイトの設定は読まず strict + 大きすぎる、source と file は読もうとしたファイル', () => {
  const content = sizedConf('confirm_level=light\n', 65537);
  assert.equal(Buffer.byteLength(content), 65537);
  const j = judgeDir(scenario(content));
  assert.equal(j.level, 'strict');
  assert.ok(warned(j, '大きすぎる'), JSON.stringify(j.warnings));
  assert.equal(j.source, `origin/main:${CONF}`);
  assert.equal(j.file, CONF);
});

test('M2c: 作業ツリーに 65537 バイト以上の設定があっても、ハングせず strict（ref が strict）', () => {
  const work = scenario('confirm_level=strict\n');
  writeConf(work, sizedConf('confirm_level=light\n', 70000));
  const r = spawnSync('bash', [SCRIPT, '--dir', work], { encoding: 'buffer', timeout: 20000 });
  const j = parseStrict(r);
  assert.equal(j.level, 'strict');
});

// ---- Minor の固定 ----

test('m-a: = の無い行は未知のキーとして警告する', () => {
  const j = judgeDir(scenario('garbage\nconfirm_level=light\n'));
  assert.equal(j.level, 'light');
  assert.ok(warned(j, '未知のキー'), JSON.stringify(j.warnings));
});

test('m-b: 作業ツリーで confirm_level が重複している場合は light 宣言として扱わない（未マージ警告なし）', () => {
  const work = scenario('confirm_level=strict\n');
  writeConf(work, 'confirm_level=light\nconfirm_level=strict\n');
  const j = judgeDir(work);
  assert.equal(j.level, 'strict');
  assert.ok(!warned(j, '未マージの light 宣言は無視'), JSON.stringify(j.warnings));
});

test('m-c1: ref にファイルが無く作業ツリーが light のとき source は default・file は空', () => {
  const work = scenario(null);
  writeConf(work, 'confirm_level=light\n');
  const j = judgeDir(work);
  assert.equal(j.level, 'strict');
  assert.equal(j.source, 'default');
  assert.equal(j.file, '');
  assert.ok(warned(j, '未マージの light 宣言は無視'), JSON.stringify(j.warnings));
});

test('m-c2: ref が strict で作業ツリーが light のとき source は ref のファイル', () => {
  const work = scenario('confirm_level=strict\n');
  writeConf(work, 'confirm_level=light\n');
  const j = judgeDir(work);
  assert.equal(j.level, 'strict');
  assert.equal(j.source, `origin/main:${CONF}`);
  assert.equal(j.file, CONF);
  assert.ok(warned(j, '未マージの light 宣言は無視'), JSON.stringify(j.warnings));
});

test('m-d: キー重複の警告を連結すると 不正値 と キーの重複 の両方を含む', () => {
  const j = judgeDir(scenario('confirm_level=light\nconfirm_level=strict\n'));
  assert.equal(j.level, 'strict');
  assert.ok(allWarn(j).includes('不正値'), JSON.stringify(j.warnings));
  assert.ok(allWarn(j).includes('キーの重複'), JSON.stringify(j.warnings));
});

test('m-e: --dir を 2 回渡すと最後の --dir が使われる（後勝ち）', () => {
  const strict = scenario('confirm_level=strict\n');
  const light = scenario('confirm_level=light\n');
  assert.equal(judge(['--dir', strict, '--dir', light]).level, 'light');
  assert.equal(judge(['--dir', light, '--dir', strict]).level, 'strict');
});

test('m-f1: 不正値 1 件のとき警告はちょうど 1 本', () => {
  const j = judgeDir(scenario('confirm_level=medium\n'));
  assert.equal(j.warnings.length, 1, JSON.stringify(j.warnings));
});

test('m-f2: 未知のキーのみのとき警告はちょうど 1 本', () => {
  const j = judgeDir(scenario('confirm_level=light\nfoo=bar\n'));
  assert.equal(j.level, 'light');
  assert.equal(j.warnings.length, 1, JSON.stringify(j.warnings));
});

// ---- 3 周目: 作業ツリー側の設定がシンボリックリンクのときの上限迂回 ----

const WT_LIMIT = 65536;
const IGNORED = '未マージの light 宣言は無視';

// 先頭が confirm_level=light、残りを # 行で埋めた、ちょうど size バイトの内容
function paddedLight(size) {
  const head = 'confirm_level=light\n';
  const rest = size - head.length;
  const line = `${'#'.repeat(79)}\n`;
  const n = Math.floor(rest / line.length);
  const tail = rest - n * line.length;
  const body = head + line.repeat(n) + (tail > 0 ? `${'#'.repeat(tail - 1)}\n` : '');
  assert.equal(Buffer.byteLength(body), size);
  return body;
}

// 作業ツリーの設定ファイルを target へのシンボリックリンクにする
function linkConf(repo, target) {
  const f = path.join(repo, CONF);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.rmSync(f, { force: true });
  fs.symlinkSync(target, f);
}

test('S1: 65537 バイト以上の通常ファイルへのシンボリックリンクは読まれず、警告も出ない', () => {
  const work = scenario('confirm_level=strict\n');
  const big = path.join(tmp(), 'big.conf');
  fs.writeFileSync(big, paddedLight(1024 * 1024));
  linkConf(work, big);
  const r = spawnSync('bash', [SCRIPT, '--dir', work], { encoding: 'utf8', timeout: 5000 });
  assert.equal(r.status, 0, `exit 0 のはず: status=${r.status} signal=${r.signal} stderr=${r.stderr}`);
  const j = JSON.parse(r.stdout.trim());
  assert.equal(j.level, 'strict');
  assert.ok(!warned(j, IGNORED), JSON.stringify(j.warnings));
});

test('S2: リポジトリ外の小さい通常ファイルへのシンボリックリンクも宣言として扱わない', () => {
  const work = scenario('confirm_level=strict\n');
  const small = path.join(tmp(), 'small.conf');
  fs.writeFileSync(small, 'confirm_level=light\n');
  linkConf(work, small);
  const j = judgeDir(work);
  assert.equal(j.level, 'strict');
  assert.ok(!warned(j, IGNORED), JSON.stringify(j.warnings));
});

test('S3a: 通常ファイルがちょうど 65536 バイトなら読まれ、未マージの light 宣言として警告される', () => {
  const work = scenario('confirm_level=strict\n');
  writeConf(work, paddedLight(WT_LIMIT));
  const j = judgeDir(work);
  assert.equal(j.level, 'strict');
  assert.ok(warned(j, IGNORED), JSON.stringify(j.warnings));
});

test('S3b: 通常ファイルが 65537 バイトなら読まれず、警告されない', () => {
  const work = scenario('confirm_level=strict\n');
  writeConf(work, paddedLight(WT_LIMIT + 1));
  const j = judgeDir(work);
  assert.equal(j.level, 'strict');
  assert.ok(!warned(j, IGNORED), JSON.stringify(j.warnings));
});

test('S3c: ref にファイルが無い場合も、65536 バイトは警告され 65537 バイトは警告されない', () => {
  const a = scenario(null);
  writeConf(a, paddedLight(WT_LIMIT));
  const ja = judgeDir(a);
  assert.equal(ja.level, 'strict');
  assert.ok(warned(ja, IGNORED), JSON.stringify(ja.warnings));
  const b = scenario(null);
  writeConf(b, paddedLight(WT_LIMIT + 1));
  const jb = judgeDir(b);
  assert.equal(jb.level, 'strict');
  assert.ok(!warned(jb, IGNORED), JSON.stringify(jb.warnings));
});

test('S4: リンク先が存在しない壊れたシンボリックリンクでも strict・exit 0・警告なし', () => {
  const work = scenario('confirm_level=strict\n');
  linkConf(work, path.join(tmp(), 'missing.conf'));
  const j = judgeDir(work);
  assert.equal(j.level, 'strict');
  assert.ok(!warned(j, IGNORED), JSON.stringify(j.warnings));
});

test('S5: ref 上が light なら、作業ツリーの設定がシンボリックリンクでも light（作業ツリーは見ない）', () => {
  const work = scenario('confirm_level=light\n');
  const small = path.join(tmp(), 'strict.conf');
  fs.writeFileSync(small, 'confirm_level=strict\n');
  linkConf(work, small);
  const j = judgeDir(work);
  assert.equal(j.level, 'light');
  assert.equal(j.source, `origin/main:${CONF}`);
});
