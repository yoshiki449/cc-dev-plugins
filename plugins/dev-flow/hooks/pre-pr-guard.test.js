#!/usr/bin/env node
'use strict';

// pre-pr-guard.sh（dev-ship 経由チェック）のテスト。
// 実行: node --test plugins/dev-flow/hooks/pre-pr-guard.test.js
//
// このガードは pre-edit-protect と同じく「ブロックし損ねても何も起きない」種類の失敗をする。
// exit 0 は「正当な通過」と「ガードが無効化されている」の区別がつかないので、
// 素通りさせるべきケースとブロックすべきケースを両方向で固定する。
//
// Issue #36 / #39 由来の回帰テスト:
//   #36 マーカーが .agent/ にあったため、worktree（.agent/ が無い）では
//       スコープガードごと素通りし、main clone 側に "main" と書かれたマーカーが残ると
//       ガードが恒久的に無効化されていた。
//   #39 対象リポを PreToolUse の cwd だけで解決していたため、
//       `cd <別リポ> && gh pr create` がセッション cwd 側のリポで判定されていた。
//   （番号なし）誤検知フィルタがシングル/ダブルクォートしか剥がさず、バッククォート内の
//       文字列（このテストファイル自身）でブロックされた。#36/#39 の作業中に実測で発見。

const test = require('node:test');
const assert = require('node:assert');
const { spawnSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOK = path.join(__dirname, 'pre-pr-guard.sh');

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

// PR 作成コマンドをリテラルで書くと、このテストファイルを Bash 経由で生成・編集する際に
// ガード自身に誤検知されるため、実行時に組み立てる（この PR の作業中に実際に踏んだ）。
const PR_CMD = ['gh', 'pr', 'create'].join(' ');

function git(dir, args) {
  return execFileSync('git', args, { cwd: dir, env: GIT_ENV, encoding: 'utf8' });
}

function mkdtemp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-pr-guard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // macOS の /tmp は /private/tmp への symlink なので、git が返すパスと
  // テスト側のパスがズレる。実パスに正規化してから使う。
  return fs.realpathSync(dir);
}

// main clone（.agent/ あり）を作る。dev-flow を使っているリポジトリの最小形。
function makeRepo(t, { agent = true, branch = 'main' } = {}) {
  const dir = mkdtemp(t);
  git(dir, ['init', '-q', '-b', branch]);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['config', 'user.email', 't@example.com']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'init']);
  if (agent) fs.mkdirSync(path.join(dir, '.agent'), { recursive: true });
  return dir;
}

// 規約どおりの worktree（<repo>/.claude/worktrees/<name>）を切る。
// .agent/ は gitignore 相当でチェックアウトされない前提を再現するため作らない。
function addWorktree(repo, name, branch) {
  const wt = path.join(repo, '.claude', 'worktrees', name);
  git(repo, ['worktree', 'add', '-q', '-b', branch, wt]);
  return wt;
}

// マーカーの正しい置き場所（worktree と main clone で共有される .git 実体の下）。
function markerPath(dir) {
  let common = git(dir, ['rev-parse', '--git-common-dir']).trim();
  if (!path.isAbsolute(common)) common = path.resolve(dir, common);
  return path.join(common, 'dev-ship-active');
}

function writeMarker(dir, branch) {
  fs.writeFileSync(markerPath(dir), `${branch}\n`);
}

function runHook({ cwd, command }) {
  return spawnSync('bash', [HOOK], {
    input: JSON.stringify({ cwd, tool_input: { command } }),
    encoding: 'utf8',
    env: GIT_ENV,
  });
}

const PASS = 0;
const BLOCK = 2;

// --- 対象外のコマンド（既存挙動の維持）-----------------------------------------

test('PR 作成を含まないコマンドは対象外', (t) => {
  const repo = makeRepo(t);
  assert.equal(runHook({ cwd: repo, command: 'git status' }).status, PASS);
});

test('クォート内の PR 作成コマンドは誤検知しない（シングル/ダブル/バッククォート）', (t) => {
  const repo = makeRepo(t);
  git(repo, ['checkout', '-qb', 'feature/x']);

  for (const [label, quoted] of [
    ['ダブル', `git commit -m "${PR_CMD} の手順を書いた"`],
    ['シングル', `git commit -m '${PR_CMD} の手順を書いた'`],
    // バッククォートは JS のテンプレートリテラルや Markdown のインラインコードで
    // 頻出する。旧実装はここを剥がさず、**このテストファイルを heredoc で書く操作自体が
    // ブロックされた**（実測）。区切り文字の直後だけでなく、中に && を挟んだ形が本体。
    ['バッククォート', 'echo `cd /tmp && ' + PR_CMD + ' --fill`'],
  ]) {
    const res = runHook({ cwd: repo, command: quoted });
    assert.equal(res.status, PASS, `${label}クォート内の文字列でブロックされている`);
  }
});

test('git リポジトリ外での PR 作成は対象外（cd 指定なし）', (t) => {
  const dir = mkdtemp(t);
  assert.equal(runHook({ cwd: dir, command: PR_CMD }).status, PASS);
});

test('.agent/ を持たないリポジトリでは発火しない（スコープガード）', (t) => {
  const repo = makeRepo(t, { agent: false });
  git(repo, ['checkout', '-qb', 'feature/x']);
  assert.equal(runHook({ cwd: repo, command: PR_CMD }).status, PASS);
});

// --- 基本形: main clone 直下 ----------------------------------------------------

test('マーカーが無ければブロックする', (t) => {
  const repo = makeRepo(t);
  git(repo, ['checkout', '-qb', 'feature/x']);
  const res = runHook({ cwd: repo, command: `${PR_CMD} --fill` });
  assert.equal(res.status, BLOCK);
  assert.match(res.stderr, /dev-ship/);
});

test('マーカーが現ブランチと一致すれば通す', (t) => {
  const repo = makeRepo(t);
  git(repo, ['checkout', '-qb', 'feature/x']);
  writeMarker(repo, 'feature/x');
  assert.equal(runHook({ cwd: repo, command: `${PR_CMD} --fill` }).status, PASS);
});

test('マーカーが別ブランチ名ならブロックする', (t) => {
  const repo = makeRepo(t);
  git(repo, ['checkout', '-qb', 'feature/x']);
  writeMarker(repo, 'main');
  assert.equal(runHook({ cwd: repo, command: `${PR_CMD} --fill` }).status, BLOCK);
});

// --- Issue #36: worktree 規約との噛み合わせ --------------------------------------

test('#36①: worktree から ship しても誤ブロックされない（cwd が main clone でも）', (t) => {
  const repo = makeRepo(t);
  const wt = addWorktree(repo, 'issue-1', 'fix/issue-1');
  // dev-ship E0 は ship 対象（worktree）のブランチ名を共有マーカーに書く。
  writeMarker(wt, 'fix/issue-1');

  // cwd は main clone のまま（worktree 規約では git -C で操作するので普通に起きる）。
  const res = runHook({ cwd: repo, command: `cd ${wt} && ${PR_CMD} --fill` });
  assert.equal(res.status, PASS, 'worktree の正当な ship がブロックされている（#36①）');
});

test('#36②: main clone に main と書かれたマーカーが残っていても worktree の PR は素通りしない', (t) => {
  const repo = makeRepo(t);
  const wt = addWorktree(repo, 'issue-2', 'fix/issue-2');
  // 旧実装ではこれが「ガードを満たす」状態だった（cwd=main clone / ブランチ=main）。
  writeMarker(repo, 'main');

  const res = runHook({ cwd: repo, command: `cd ${wt} && ${PR_CMD} --fill` });
  assert.equal(
    res.status,
    BLOCK,
    'ship 対象ブランチと無関係なマーカーでガードが満たされている（#36②の恒久無効化）',
  );
});

test('#36: worktree に .agent/ が無くてもスコープガードが発火する', (t) => {
  const repo = makeRepo(t);
  const wt = addWorktree(repo, 'issue-3', 'fix/issue-3');
  assert.ok(!fs.existsSync(path.join(wt, '.agent')), 'fixture の前提が崩れている');

  const res = runHook({ cwd: repo, command: `cd ${wt} && ${PR_CMD} --fill` });
  assert.equal(res.status, BLOCK, 'worktree では .agent/ が無いためガードごと素通りしている（#36）');
});

test('#36: 旧マーカー（.agent/.dev-ship-active）は受け入れない', (t) => {
  const repo = makeRepo(t);
  git(repo, ['checkout', '-qb', 'feature/old']);
  fs.writeFileSync(path.join(repo, '.agent', '.dev-ship-active'), 'feature/old\n');

  const res = runHook({ cwd: repo, command: `${PR_CMD} --fill` });
  assert.equal(res.status, BLOCK, '旧マーカーを受け入れると #36② の穴が残る');
});

test('cd の構文: ~ 展開（HOME 配下のリポを cd 先に指定できる）', (t) => {
  // 実装は `~` / `~/...` だけを展開する（$VAR は展開できないので fail-closed に倒れる）。
  // HOME 配下に fixture を作らないと検証できないため、HOME を差し替えて実行する。
  const home = mkdtemp(t);
  const repoB = makeRepo(t);
  git(repoB, ['checkout', '-qb', 'feature/b']);
  writeMarker(repoB, 'feature/b');

  const repoA = makeRepo(t);
  // ~ が repoB を指すように、HOME 配下に repoB へのシンボリックリンクを置く
  fs.symlinkSync(repoB, path.join(home, 'target'));

  const res = spawnSync('bash', [HOOK], {
    input: JSON.stringify({
      cwd: repoA,
      tool_input: { command: `cd ~/target && ${PR_CMD} --fill` },
    }),
    encoding: 'utf8',
    env: { ...GIT_ENV, HOME: home },
  });
  assert.equal(res.status, PASS, '~ 展開が効かず対象リポを解決できていない');
});

// --- Issue #39: cd で別リポへ移動するケース --------------------------------------

test('#39: cd で移動した先のリポのマーカーとブランチで判定される', (t) => {
  const repoA = makeRepo(t); // セッション cwd 側
  const repoB = makeRepo(t); // 実際に PR を作る側
  git(repoB, ['checkout', '-qb', 'feature/b']);
  writeMarker(repoB, 'feature/b');

  const res = runHook({ cwd: repoA, command: `cd ${repoB} && ${PR_CMD} --fill` });
  assert.equal(res.status, PASS, 'リポB の正当なマーカーが評価されていない');
});

test('#39: cwd 側にマーカーが残っていても別リポの PR は素通りしない（偽陰性）', (t) => {
  const repoA = makeRepo(t);
  const repoB = makeRepo(t);
  git(repoA, ['checkout', '-qb', 'feature/a']);
  writeMarker(repoA, 'feature/a'); // リポA では正当な ship 中
  git(repoB, ['checkout', '-qb', 'feature/b']); // リポB は dev-ship を経由していない

  const res = runHook({ cwd: repoA, command: `cd ${repoB} && ${PR_CMD} --fill` });
  assert.equal(res.status, BLOCK, 'cwd 側のマーカーで別リポの PR が素通りしている（#39 偽陰性）');
});

test('#39: ブロックメッセージのマーカーパスとブランチが対象リポのものになる', (t) => {
  const repoA = makeRepo(t);
  const repoB = makeRepo(t);
  writeMarker(repoA, 'main');
  git(repoB, ['checkout', '-qb', 'feature/b']);

  const res = runHook({ cwd: repoA, command: `cd ${repoB} && ${PR_CMD} --fill` });
  assert.equal(res.status, BLOCK);
  assert.ok(
    res.stderr.includes(markerPath(repoB)),
    `案内が対象リポのマーカーパスになっていない: ${res.stderr}`,
  );
  assert.ok(!res.stderr.includes(repoA), '案内に cwd 側のリポのパスが混ざっている');
});

test('#39: cd 先が解決できなければ fail-closed でブロックする', (t) => {
  const repoA = makeRepo(t);
  writeMarker(repoA, 'main'); // cwd 側は「正当」な状態

  const res = runHook({
    cwd: repoA,
    command: `cd /nonexistent/path/xyz && ${PR_CMD} --fill`,
  });
  assert.equal(res.status, BLOCK, '解決不能な cd 先が素通りしている（fail-closed でない）');
});

test('#39: cd 先が git リポジトリでなければ fail-closed でブロックする', (t) => {
  const repoA = makeRepo(t);
  writeMarker(repoA, 'main');
  const plain = mkdtemp(t);

  const res = runHook({ cwd: repoA, command: `cd ${plain} && ${PR_CMD} --fill` });
  assert.equal(res.status, BLOCK, 'git リポでない cd 先が素通りしている');
});

test('#39: クォート付きの cd パスも解決できる', (t) => {
  const repoA = makeRepo(t);
  const repoB = makeRepo(t);
  git(repoB, ['checkout', '-qb', 'feature/b']);
  writeMarker(repoB, 'feature/b');

  const res = runHook({ cwd: repoA, command: `cd "${repoB}" && ${PR_CMD} --fill` });
  assert.equal(res.status, PASS, 'クォート付きの cd が解決できていない');
});

// --- セルフレビューで見つかったバイパス（いずれも main の時点から存在した穴）-------
//
// 「対象リポは cwd ではなくコマンドが実際に触るリポジトリ」という設計意図に対して、
// `cd` トークンだけを見ていたため、同じ効果を持つ他の書き方をすべて取り逃がしていた。
// 5形態とも repoB（dev-ship 未経由）で PR を作るのに repoA（経由済み）のマーカーで
// 素通りすることを実測してから塞いだ。

// cwd 側は「正当に ship 中」、PR を作る先は未経由、という最も危険な組み合わせを作る。
function twoRepos(t) {
  const repoA = makeRepo(t);
  const repoB = makeRepo(t);
  git(repoA, ['checkout', '-qb', 'feature/a']);
  writeMarker(repoA, 'feature/a');
  git(repoB, ['checkout', '-qb', 'feature/b']);
  return { repoA, repoB };
}

test('バイパス: bash -c / sh -c / eval で包んでも素通りしない', (t) => {
  const { repoA, repoB } = twoRepos(t);

  // クォートの中身が「地の文」ではなく**実際に実行されるコマンド**なので、
  // 誤検知対策のクォート除去をそのまま適用すると検査対象が丸ごと消えていた。
  for (const wrap of [
    `bash -c "cd ${repoB} && ${PR_CMD} --fill"`,
    `sh -c 'cd ${repoB} && ${PR_CMD} --fill'`,
    `eval "cd ${repoB} && ${PR_CMD} --fill"`,
    `timeout 30 bash -c "cd ${repoB} && ${PR_CMD} --fill"`,
  ]) {
    const res = runHook({ cwd: repoA, command: wrap });
    assert.equal(res.status, BLOCK, `ラッパー経由で素通りしている: ${wrap.slice(0, 40)}`);
  }
});

test('バイパス: pushd も cd と同じく対象リポの解決に使う', (t) => {
  const { repoA, repoB } = twoRepos(t);
  const res = runHook({ cwd: repoA, command: `pushd ${repoB} && ${PR_CMD} --fill` });
  assert.equal(res.status, BLOCK, 'pushd が cd として認識されず cwd 側で判定されている');
});

test('バイパス: サブシェル (cd ... && ...) でも素通りしない', (t) => {
  const { repoA, repoB } = twoRepos(t);
  const res = runHook({ cwd: repoA, command: `(cd ${repoB} && ${PR_CMD} --fill)` });
  assert.equal(res.status, BLOCK, 'サブシェル形の cd が拾えていない（区切り文字に ( が無い）');
});

test('バイパス: ラッパー経由でも正当な ship は通る（過剰ブロックしない）', (t) => {
  const repo = makeRepo(t);
  git(repo, ['checkout', '-qb', 'feature/x']);
  writeMarker(repo, 'feature/x');

  const res = runHook({ cwd: repo, command: `bash -c "cd ${repo} && ${PR_CMD} --fill"` });
  assert.equal(res.status, PASS, 'ラッパー対応が正当な ship まで巻き込んでブロックしている');
});

// --- cd の構文バリエーション（実装はあるがテストが無かった分）---------------------

test('cd の構文: 相対パス・cd -- を解決できる（~ 展開は下の別ケース）', (t) => {
  const { repoA, repoB } = twoRepos(t);
  writeMarker(repoB, 'feature/b');

  // repoA から見た repoB への相対パス（cwd 起点で解決される）
  const rel = path.relative(repoA, repoB);
  assert.equal(
    runHook({ cwd: repoA, command: `cd ${rel} && ${PR_CMD} --fill` }).status,
    PASS,
    '相対パスの cd が解決できていない',
  );

  // `cd -- <path>`（オプション終端）も正当な構文
  assert.equal(
    runHook({ cwd: repoA, command: `cd -- ${repoB} && ${PR_CMD} --fill` }).status,
    PASS,
    'cd -- が解決できず誤ブロックしている',
  );
});

test('#39: PR 作成より後ろの cd は対象リポの解決に使わない', (t) => {
  const repoA = makeRepo(t);
  const repoB = makeRepo(t);
  git(repoA, ['checkout', '-qb', 'feature/a']);
  writeMarker(repoA, 'feature/a');

  // 実際に PR を作るのは repoA（cwd）。後続の cd は無関係。
  const res = runHook({ cwd: repoA, command: `${PR_CMD} --fill && cd ${repoB}` });
  assert.equal(res.status, PASS, 'PR 作成より後ろの cd を対象リポにしている');
});

// --- Issue #68: コマンドに書かれた「データ」を実行されるコマンドとして読まない -------
//
// 発火条件の判定と移動先の解決は、どちらもコマンド文字列の走査で行っている。
// 引数の値とヒアドキュメントの本体は**コマンドではなくデータ**なので、そこに現れた語で
// 判定してはいけない。実測で2経路踏んだ:
//   1. PR 本文の日本語に移動コマンドの2文字が含まれ、その先が移動先として切り出された
//   2. 別コマンドのヒアドキュメントに PR 作成コマンドの文字列があり、そちらがブロックされた
//
// 緩める方向の変更なので、**止まるべきケースが止まり続けること**を同じ節で固定する。

test('#68-1: PR 本文の自然文が移動先として解釈されない', (t) => {
  const repo = makeRepo(t);
  const wt = addWorktree(repo, 'feat-x', 'feature/x');
  writeMarker(wt, 'feature/x');

  // 本文に「移動コマンドの2文字 + 空白 + 日本語」が入っている。
  // 実際に出た文面は「hook の cd 候補収集を消す」だった。
  // 本文を変数に入れてから渡す形（実際に踏んだのはこの形。本文が PR 作成コマンドより
  // 前に現れるので、移動先の抽出範囲に入ってしまう）
  const body = 'hook の ' + 'cd' + ' 候補収集を消す';
  const r = runHook({
    cwd: wt,
    command: `BODY="${body}" && ${PR_CMD} --title t --body "$BODY"`,
  });

  assert.strictEqual(r.status, PASS, `本文のテキストで誤ブロックした\n${r.stderr}`);
});

test('#68-2: 別コマンドのヒアドキュメントに PR 作成コマンドが書かれていても発火しない', (t) => {
  const repo = makeRepo(t);

  // Issue を起票するコマンドの本文に、PR 作成コマンドの説明が入っているだけ。
  // ヒアドキュメントの本体はコマンドへ渡す入力であって、実行されるコマンドではない。
  const command = [
    "gh issue create --title t --body-file - <<'EOF'",
    '## 再現',
    `${PR_CMD} --base main --head x`,
    'EOF',
  ].join('\n');

  const r = runHook({ cwd: repo, command });
  assert.strictEqual(r.status, PASS, `ヒアドキュメントの本文で発火した\n${r.stderr}`);
});

test('#68-3: 本物の移動つき PR 作成は引き続きブロックされる', (t) => {
  const repo = makeRepo(t);
  const other = makeRepo(t);
  // マーカーは cwd 側にだけある。移動先のリポジトリには無い
  writeMarker(repo, 'main');

  const r = runHook({ cwd: repo, command: `cd ${other} && ${PR_CMD} --title t` });
  assert.strictEqual(r.status, BLOCK, '移動先のリポジトリで判定していない');
});

test('#68-4: ラッパー経由の PR 作成は引き続きブロックされる', (t) => {
  const repo = makeRepo(t);
  const other = makeRepo(t);
  writeMarker(repo, 'main');

  const r = runHook({ cwd: repo, command: `bash -c "cd ${other} && ${PR_CMD} --title t"` });
  assert.strictEqual(r.status, BLOCK, 'ラッパーの中身が検査対象から外れている');
});

test('#68-5: ヒアドキュメントをシェルに食わせる形はブロックされる', (t) => {
  const repo = makeRepo(t);
  const other = makeRepo(t);
  writeMarker(repo, 'main');

  // ここでのヒアドキュメント本体は**実行されるコマンド**なので、データとして落としてはいけない。
  const command = ["bash <<'EOF'", `cd ${other}`, `${PR_CMD} --title t`, 'EOF'].join('\n');

  const r = runHook({ cwd: repo, command });
  assert.strictEqual(r.status, BLOCK, 'シェルに渡すヒアドキュメントを素通りさせた');
});

test('#68-6: 本文の自然文を落としても、移動先の指定は拾う', (t) => {
  const repo = makeRepo(t);
  const other = makeRepo(t);
  writeMarker(repo, 'main');

  // 本文にも移動コマンドの文字列があり、かつ本物の移動もある。
  // 落とすのは本文だけで、実際の移動先は解決できなければならない。
  const body = 'hook の ' + 'cd' + ' 候補収集を消す';
  const r = runHook({
    cwd: repo,
    command: `cd ${other} && BODY="${body}" && ${PR_CMD} --title t --body "$BODY"`,
  });

  assert.strictEqual(r.status, BLOCK, '本文ごと移動先まで落としている');
  assert.match(r.stderr, new RegExp(other.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    '解決した移動先が実際の移動先になっていない');
});

test('#68-7: ヒアドキュメントで本文ファイルを作ってから PR を作れる', (t) => {
  const repo = makeRepo(t);
  const wt = addWorktree(repo, 'feat-y', 'feature/y');
  writeMarker(wt, 'feature/y');

  // 本文に「行頭が移動コマンド」の手順が書かれている。行頭はコマンドの位置なので、
  // ヒアドキュメントの本体を落としていないと、これが移動先として採用される。
  // 移動先は実在しないので fail-closed 側に倒れ、正当な PR 作成がブロックされる。
  const command = [
    "cat > /tmp/body.md <<'EOF'",
    '## 再現手順',
    'cd /nonexistent-repo-for-test',
    'EOF',
    `${PR_CMD} --title t --body-file /tmp/body.md`,
  ].join('\n');

  const r = runHook({ cwd: wt, command });
  assert.strictEqual(r.status, PASS, `本文ファイルの中身を移動先として拾った\n${r.stderr}`);
});

test('#68-8: 複数行にまたがる本文の行頭が移動先として解釈されない', (t) => {
  const repo = makeRepo(t);
  const wt = addWorktree(repo, 'feat-z', 'feature/z');
  writeMarker(wt, 'feature/z');

  // `--body` の値が実際の改行を含み、その行の1つが行頭から移動コマンドで始まる。
  // 切り出しが行単位だと PR 作成コマンドより後ろの行が残り、行頭は
  // コマンドの位置なので移動先として採用されてしまう（#68 と同じ失敗モードの別形態）。
  const body = ['line1', 'cd /nonexistent-xyz', 'line3'].join('\n');
  const r = runHook({ cwd: wt, command: `${PR_CMD} --title t --body "${body}"` });

  assert.strictEqual(r.status, PASS, `複数行の本文で誤ブロックした\n${r.stderr}`);
});

test('#68-9: 複数行でも、PR 作成コマンドより前の移動先は拾う', (t) => {
  const repo = makeRepo(t);
  const other = makeRepo(t);
  writeMarker(repo, 'main');

  // 切り出しを厳しくしすぎて、前にある本物の移動まで落とさないこと。
  const command = [`cd ${other}`, 'echo 準備', `${PR_CMD} --title t`].join('\n');
  const r = runHook({ cwd: repo, command });

  assert.strictEqual(r.status, BLOCK, '複数行の本物の移動を見落とした');
});

test('#68-10: 移動先を解決できないとき、案内が原因の候補を示す', (t) => {
  const repo = makeRepo(t);
  writeMarker(repo, 'main');

  // 変数は展開できないので必ず解決に失敗する。実際にこのセッションで踏んだ形。
  // 案内が「対象リポジトリに移動して再実行」だけだと、移動しても結果は変わらないので
  // 読み手が同じ操作を繰り返すことになる（#67 と同系統）。
  const r = runHook({ cwd: repo, command: 'cd $OTHER && ' + PR_CMD });

  assert.strictEqual(r.status, BLOCK);
  assert.match(r.stderr, /\$VAR/, '変数を展開できないことを案内していない');
  assert.match(r.stderr, /body-file/, '本文が原因の場合の回避策を案内していない');
});

// --- 区切りを絞ったことで開いた穴（セルフレビューの Code-Reviewer が実測で検出）-----

test('#68-11: シェルのキーワードの直後の移動も拾う', (t) => {
  const repo = makeRepo(t);
  const other = makeRepo(t);
  writeMarker(repo, 'main');

  // `then` `do` `{` の直後はコマンドの位置。区切りを記号だけに絞ると、
  // 別リポジトリへの移動を条件分岐やループの中に置くだけでガードを抜けられる。
  const shapes = [
    `if true; then cd ${other} && ${PR_CMD}; fi`,
    `for i in 1; do cd ${other} && ${PR_CMD}; done`,
    `{ cd ${other} && ${PR_CMD}; }`,
    `while true; do cd ${other} && ${PR_CMD}; done`,
    `if false; then true; else cd ${other} && ${PR_CMD}; fi`,
  ];
  for (const command of shapes) {
    const r = runHook({ cwd: repo, command });
    assert.strictEqual(r.status, BLOCK, `キーワードの直後の移動を見落とした: ${command}`);
  }
});

test('#68-12: クォートの中の << はヒアドキュメントの開始ではない', (t) => {
  const repo = makeRepo(t);
  const other = makeRepo(t);
  writeMarker(repo, 'main');

  // `echo "docs<<EOF"` は実機の bash ではヒアドキュメントにならない。
  // 開始と誤認すると、そのあとの本物の移動行が本体として丸ごと落ちる。
  const command = ['echo "docs<<EOF"', `cd ${other}`, PR_CMD].join('\n');
  const r = runHook({ cwd: repo, command });

  assert.strictEqual(r.status, BLOCK, 'クォート内の << をヒアドキュメントと誤認した');
});

test('#68-13: ヒアドキュメントの終端はインデントの扱いを区別する', (t) => {
  const repo = makeRepo(t);
  const other = makeRepo(t);
  writeMarker(repo, 'main');

  // `<<-` はタブを剥がして終端を判定するが、`<<` は行頭一致でなければ終端ではない。
  // 緩く判定すると本体が早く終わり、続きの行が走査対象に戻る。
  // ここでは「インデントされた EOF では終わらない」ことを、後続の移動が拾われることで見る。
  const command = [
    "cat > /tmp/x.md <<EOF",
    '  EOF',
    `cd ${other}`,
    'EOF',
    PR_CMD,
  ].join('\n');
  const r = runHook({ cwd: repo, command });

  assert.strictEqual(r.status, PASS, 'インデントされた終端で本体を打ち切っている');
});

test('#68-14: command / builtin 経由の移動も拾う', (t) => {
  const repo = makeRepo(t);
  const other = makeRepo(t);
  writeMarker(repo, 'main');

  // `cd` はシェルの組み込みなので `command cd` / `builtin cd` で呼べる。
  // 区切りを絞ったとき、直前が空白なだけのこの形を落としていた
  // （旧版はブロックしていた。別モデル視点のレビューが弱点として挙げ、実測で確認した）。
  for (const prefix of ['command', 'builtin']) {
    const r = runHook({ cwd: repo, command: `${prefix} cd ${other} && ${PR_CMD}` });
    assert.strictEqual(r.status, BLOCK, `${prefix} 経由の移動を見落とした`);
  }
});
