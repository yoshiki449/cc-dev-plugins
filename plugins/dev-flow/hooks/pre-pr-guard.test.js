#!/usr/bin/env node
'use strict';

// pre-pr-guard.sh（PR マージの承認確認 + dev-ship 未経由 PR 作成の注意書き）のテスト。
// 実行: node --test plugins/dev-flow/hooks/pre-pr-guard.test.js
//
// このフックは pre-edit-protect と同じく「効かなくても何も起きない」種類の失敗をする。
// exit 0 は「正当な通過」とフックが無効化されている状態の区別がつかないので、
// 黙って通すべきケースと、注意書き・承認確認を出すべきケースを両方向で固定する。
// 結果は 4 通り（classify を参照）: silent / remind / ask / block。PR 作成は block にならない。
//
// Issue #64: PR 作成のブロックをやめ、マージだけ承認確認を必須にした。それ以前の
// 回帰テスト（#36 / #39 / #68）は、ブロックの代わりに「注意書きが出る」ことで同じ性質を固定している。
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

// フックの結果を 4 通りに分類する。exit 0 だけでは「何も言わず通した」と「注意書きを出して通した」と
// 「承認確認を挟んだ」を区別できないため、stdout の JSON まで見る。
//   silent: exit 0 で出力なし / remind: additionalContext を注入 / ask: 承認確認を要求 / block: exit 2
function classify(res) {
  if (res.status === 2) return 'block';
  if (res.status !== 0) return `exit${res.status}`;
  if (res.stdout.trim() === '') return 'silent';
  const out = JSON.parse(res.stdout).hookSpecificOutput;
  if (out.permissionDecision === 'ask') return 'ask';
  if (typeof out.additionalContext === 'string') return 'remind';
  return 'other';
}

function withOutcome(res) {
  res.outcome = classify(res);
  return res;
}

function runHook({ cwd, command, tool = 'Bash' }) {
  return withOutcome(
    spawnSync('bash', [HOOK], {
      input: JSON.stringify({ cwd, tool_name: tool, tool_input: { command } }),
      encoding: 'utf8',
      env: GIT_ENV,
    }),
  );
}

// 注意書きの本文（additionalContext）を取り出す。
function context(res) {
  return JSON.parse(res.stdout).hookSpecificOutput.additionalContext;
}

const SILENT = 'silent';
const REMIND = 'remind';
const ASK = 'ask';

// --- 対象外のコマンド（既存挙動の維持）-----------------------------------------

test('PR 作成を含まないコマンドは対象外', (t) => {
  const repo = makeRepo(t);
  assert.equal(runHook({ cwd: repo, command: 'git status' }).outcome, SILENT);
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
    assert.equal(res.outcome, SILENT, `${label}クォート内の文字列で発火している`);
  }
});

test('git リポジトリ外での PR 作成は対象外（cd 指定なし）', (t) => {
  const dir = mkdtemp(t);
  assert.equal(runHook({ cwd: dir, command: PR_CMD }).outcome, SILENT);
});

test('.agent/ を持たないリポジトリでは発火しない（スコープガード）', (t) => {
  const repo = makeRepo(t, { agent: false });
  git(repo, ['checkout', '-qb', 'feature/x']);
  assert.equal(runHook({ cwd: repo, command: PR_CMD }).outcome, SILENT);
});

// --- 基本形: main clone 直下 ----------------------------------------------------

test('マーカーが無ければ注意書きを出す（止めない）', (t) => {
  const repo = makeRepo(t);
  git(repo, ['checkout', '-qb', 'feature/x']);
  const res = runHook({ cwd: repo, command: `${PR_CMD} --fill` });
  assert.equal(res.status, 0, 'PR 作成が止められている');
  assert.equal(res.outcome, REMIND);
  assert.match(context(res), /dev-ship/);
  assert.ok(!res.stdout.includes('permissionDecision'), 'PR 作成の権限フローに触れている');
});

test('マーカーが現ブランチと一致すれば黙って通す', (t) => {
  const repo = makeRepo(t);
  git(repo, ['checkout', '-qb', 'feature/x']);
  writeMarker(repo, 'feature/x');
  assert.equal(runHook({ cwd: repo, command: `${PR_CMD} --fill` }).outcome, SILENT);
});

test('マーカーが別ブランチ名なら注意書きを出す', (t) => {
  const repo = makeRepo(t);
  git(repo, ['checkout', '-qb', 'feature/x']);
  writeMarker(repo, 'main');
  assert.equal(runHook({ cwd: repo, command: `${PR_CMD} --fill` }).outcome, REMIND);
});

// --- Issue #36: worktree 規約との噛み合わせ --------------------------------------

test('#36①: worktree から ship しても注意書きが出ない（cwd が main clone でも）', (t) => {
  const repo = makeRepo(t);
  const wt = addWorktree(repo, 'issue-1', 'fix/issue-1');
  // dev-ship E0 は ship 対象（worktree）のブランチ名を共有マーカーに書く。
  writeMarker(wt, 'fix/issue-1');

  // cwd は main clone のまま（worktree 規約では git -C で操作するので普通に起きる）。
  const res = runHook({ cwd: repo, command: `cd ${wt} && ${PR_CMD} --fill` });
  assert.equal(res.outcome, SILENT, 'worktree の正当な ship に注意書きが出ている（#36①）');
});

test('#36②: main clone に main と書かれたマーカーが残っていても worktree の PR は素通りしない', (t) => {
  const repo = makeRepo(t);
  const wt = addWorktree(repo, 'issue-2', 'fix/issue-2');
  // 旧実装ではこれが「ガードを満たす」状態だった（cwd=main clone / ブランチ=main）。
  writeMarker(repo, 'main');

  const res = runHook({ cwd: repo, command: `cd ${wt} && ${PR_CMD} --fill` });
  assert.equal(
    res.outcome,
    REMIND,
    'ship 対象ブランチと無関係なマーカーでガードが満たされている（#36②の恒久無効化）',
  );
});

test('#36: worktree に .agent/ が無くてもスコープガードが発火する', (t) => {
  const repo = makeRepo(t);
  const wt = addWorktree(repo, 'issue-3', 'fix/issue-3');
  assert.ok(!fs.existsSync(path.join(wt, '.agent')), 'fixture の前提が崩れている');

  const res = runHook({ cwd: repo, command: `cd ${wt} && ${PR_CMD} --fill` });
  assert.equal(res.outcome, REMIND, 'worktree では .agent/ が無いためガードごと素通りしている（#36）');
});

test('#36: 旧マーカー（.agent/.dev-ship-active）は受け入れない', (t) => {
  const repo = makeRepo(t);
  git(repo, ['checkout', '-qb', 'feature/old']);
  fs.writeFileSync(path.join(repo, '.agent', '.dev-ship-active'), 'feature/old\n');

  const res = runHook({ cwd: repo, command: `${PR_CMD} --fill` });
  assert.equal(res.outcome, REMIND, '旧マーカーを受け入れると #36② の穴が残る');
});

test('cd の構文: ~ 展開（HOME 配下のリポを cd 先に指定できる）', (t) => {
  // 実装は `~` / `~/...` だけを展開する（$VAR は展開できないので解決失敗で黙って通る）。
  // HOME 配下に fixture を作らないと検証できないため、HOME を差し替えて実行する。
  const home = mkdtemp(t);
  const repoB = makeRepo(t);
  git(repoB, ['checkout', '-qb', 'feature/b']); // 未経由。展開が効けば repoB の注意書きが出る

  const repoA = makeRepo(t);
  // ~ が repoB を指すように、HOME 配下に repoB へのシンボリックリンクを置く
  fs.symlinkSync(repoB, path.join(home, 'target'));

  const res = withOutcome(spawnSync('bash', [HOOK], {
    input: JSON.stringify({
      cwd: repoA,
      tool_input: { command: `cd ~/target && ${PR_CMD} --fill` },
    }),
    encoding: 'utf8',
    env: { ...GIT_ENV, HOME: home },
  }));
  // 展開できないと対象リポを解決できず、解決失敗は黙って通すので、SILENT では取り違えと区別できない。
  assert.equal(res.outcome, REMIND, '~ 展開が効かず対象リポを解決できていない');
  assert.ok(context(res).includes(repoB), '注意書きの対象が展開先のリポになっていない');
});

// --- Issue #39: cd で別リポへ移動するケース --------------------------------------

test('#39: cd で移動した先のリポのマーカーとブランチで判定される', (t) => {
  const repoA = makeRepo(t); // セッション cwd 側
  const repoB = makeRepo(t); // 実際に PR を作る側
  git(repoB, ['checkout', '-qb', 'feature/b']);
  writeMarker(repoB, 'feature/b');

  const res = runHook({ cwd: repoA, command: `cd ${repoB} && ${PR_CMD} --fill` });
  assert.equal(res.outcome, SILENT, 'リポB の正当なマーカーが評価されていない');
});

test('#39: cwd 側にマーカーが残っていても別リポの PR は素通りしない（偽陰性）', (t) => {
  const repoA = makeRepo(t);
  const repoB = makeRepo(t);
  git(repoA, ['checkout', '-qb', 'feature/a']);
  writeMarker(repoA, 'feature/a'); // リポA では正当な ship 中
  git(repoB, ['checkout', '-qb', 'feature/b']); // リポB は dev-ship を経由していない

  const res = runHook({ cwd: repoA, command: `cd ${repoB} && ${PR_CMD} --fill` });
  assert.equal(res.outcome, REMIND, 'cwd 側のマーカーで別リポの PR が素通りしている（#39 偽陰性）');
});

test('#39: 注意書きのマーカーパスとブランチが対象リポのものになる', (t) => {
  const repoA = makeRepo(t);
  const repoB = makeRepo(t);
  writeMarker(repoA, 'main');
  git(repoB, ['checkout', '-qb', 'feature/b']);

  const res = runHook({ cwd: repoA, command: `cd ${repoB} && ${PR_CMD} --fill` });
  assert.equal(res.outcome, REMIND);
  assert.ok(
    context(res).includes(markerPath(repoB)),
    `案内が対象リポのマーカーパスになっていない: ${context(res)}`,
  );
  assert.ok(!context(res).includes(repoA), '案内に cwd 側のリポのパスが混ざっている');
});

test('#39: cd 先が解決できなければ黙って通す（ブロックも注意書きもしない）', (t) => {
  const repoA = makeRepo(t);
  writeMarker(repoA, 'main'); // cwd 側は「正当」な状態

  const res = runHook({
    cwd: repoA,
    command: `cd /nonexistent/path/xyz && ${PR_CMD} --fill`,
  });
  // ブロックしない設計になったので、判定材料が欠けた状態で注意書きを出して誤誘導することも避ける。
  assert.equal(res.outcome, SILENT, '解決不能な cd 先でブロックまたは注意書きが出ている');
});

test('#39: cd 先が git リポジトリでなければ黙って通す', (t) => {
  const repoA = makeRepo(t);
  writeMarker(repoA, 'main');
  const plain = mkdtemp(t);

  const res = runHook({ cwd: repoA, command: `cd ${plain} && ${PR_CMD} --fill` });
  assert.equal(res.outcome, SILENT, 'git リポでない cd 先でブロックまたは注意書きが出ている');
});

test('#39: クォート付きの cd パスも解決できる', (t) => {
  const repoA = makeRepo(t);
  const repoB = makeRepo(t);
  git(repoB, ['checkout', '-qb', 'feature/b']); // 未経由

  const res = runHook({ cwd: repoA, command: `cd "${repoB}" && ${PR_CMD} --fill` });
  assert.equal(res.outcome, REMIND, 'クォート付きの cd が解決できていない');
  assert.ok(context(res).includes(repoB), '注意書きの対象が cd 先のリポになっていない');
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
  // eval は実行内容を読めない構文として別途確認に倒すので、ここ（注意書きの対象リポ解決）には含めない。
  for (const wrap of [
    `bash -c "cd ${repoB} && ${PR_CMD} --fill"`,
    `sh -c 'cd ${repoB} && ${PR_CMD} --fill'`,
    `timeout 30 bash -c "cd ${repoB} && ${PR_CMD} --fill"`,
  ]) {
    const res = runHook({ cwd: repoA, command: wrap });
    assert.equal(res.outcome, REMIND, `ラッパー経由で素通りしている: ${wrap.slice(0, 40)}`);
  }
});

test('バイパス: pushd も cd と同じく対象リポの解決に使う', (t) => {
  const { repoA, repoB } = twoRepos(t);
  const res = runHook({ cwd: repoA, command: `pushd ${repoB} && ${PR_CMD} --fill` });
  assert.equal(res.outcome, REMIND, 'pushd が cd として認識されず cwd 側で判定されている');
});

test('バイパス: サブシェル (cd ... && ...) でも素通りしない', (t) => {
  const { repoA, repoB } = twoRepos(t);
  const res = runHook({ cwd: repoA, command: `(cd ${repoB} && ${PR_CMD} --fill)` });
  assert.equal(res.outcome, REMIND, 'サブシェル形の cd が拾えていない（区切り文字に ( が無い）');
});

test('バイパス: ラッパー経由でも正当な ship には注意書きが出ない', (t) => {
  const repo = makeRepo(t);
  git(repo, ['checkout', '-qb', 'feature/x']);
  writeMarker(repo, 'feature/x');

  const res = runHook({ cwd: repo, command: `bash -c "cd ${repo} && ${PR_CMD} --fill"` });
  assert.equal(res.outcome, SILENT, 'ラッパー対応が正当な ship まで巻き込んで注意書きを出している');
});

// --- cd の構文バリエーション（実装はあるがテストが無かった分）---------------------

test('cd の構文: 相対パス・cd -- を解決できる（~ 展開は下の別ケース）', (t) => {
  // repoA は ship 済み、repoB は未経由。解決できれば repoB の注意書きが出る
  // （解決できないと黙り、解決を取り違えて cwd を見ても黙るので、SILENT では判別できない）。
  const { repoA, repoB } = twoRepos(t);

  // repoA から見た repoB への相対パス（cwd 起点で解決される）
  const rel = path.relative(repoA, repoB);
  const byRel = runHook({ cwd: repoA, command: `cd ${rel} && ${PR_CMD} --fill` });
  assert.equal(byRel.outcome, REMIND, '相対パスの cd が解決できていない');
  assert.ok(context(byRel).includes(repoB), '相対パスの解決先が repoB でない');

  // `cd -- <path>`（オプション終端）も正当な構文
  const byDash = runHook({ cwd: repoA, command: `cd -- ${repoB} && ${PR_CMD} --fill` });
  assert.equal(byDash.outcome, REMIND, 'cd -- が解決できていない');
  assert.ok(context(byDash).includes(repoB), 'cd -- の解決先が repoB でない');
});

test('#39: PR 作成より後ろの cd は対象リポの解決に使わない', (t) => {
  const repoA = makeRepo(t);
  const repoB = makeRepo(t);
  git(repoA, ['checkout', '-qb', 'feature/a']);
  writeMarker(repoA, 'feature/a');

  // 実際に PR を作るのは repoA（cwd）。後続の cd は無関係。
  const res = runHook({ cwd: repoA, command: `${PR_CMD} --fill && cd ${repoB}` });
  assert.equal(res.outcome, SILENT, 'PR 作成より後ろの cd を対象リポにしている');
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
  const wt = addWorktree(repo, 'feat-x', 'feature/x'); // 未経由。正しく解決できれば注意書きが出る

  // 本文に「移動コマンドの2文字 + 空白 + 日本語」が入っている。
  // 実際に出た文面は「hook の cd 候補収集を消す」だった。
  // 本文を変数に入れてから渡す形（実際に踏んだのはこの形。本文が PR 作成コマンドより
  // 前に現れるので、移動先の抽出範囲に入ってしまう）
  const body = 'hook の ' + 'cd' + ' 候補収集を消す';
  const r = runHook({
    cwd: wt,
    command: `BODY="${body}" && ${PR_CMD} --title t --body "$BODY"`,
  });

  // 本文を移動先と取り違えると解決失敗で黙る。SILENT と区別するため、正しい解決を注意書きで確かめる。
  assert.strictEqual(r.outcome, REMIND, `本文のテキストを移動先として拾った\n${r.stdout}`);
  assert.ok(context(r).includes(wt), '注意書きの対象が cwd の worktree になっていない');
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
  assert.strictEqual(r.outcome, SILENT, `ヒアドキュメントの本文で発火した\n${r.stdout}`);
});

test('#68-3: 本物の移動つき PR 作成は引き続き移動先で判定される', (t) => {
  const repo = makeRepo(t);
  const other = makeRepo(t);
  // マーカーは cwd 側にだけある。移動先のリポジトリには無い
  writeMarker(repo, 'main');

  const r = runHook({ cwd: repo, command: `cd ${other} && ${PR_CMD} --title t` });
  assert.strictEqual(r.outcome, REMIND, '移動先のリポジトリで判定していない');
});

test('#68-4: ラッパー経由の PR 作成は引き続き中身まで判定される', (t) => {
  const repo = makeRepo(t);
  const other = makeRepo(t);
  writeMarker(repo, 'main');

  const r = runHook({ cwd: repo, command: `bash -c "cd ${other} && ${PR_CMD} --title t"` });
  assert.strictEqual(r.outcome, REMIND, 'ラッパーの中身が検査対象から外れている');
});

test('#68-5: ヒアドキュメントをシェルに食わせる形も中身まで判定される', (t) => {
  const repo = makeRepo(t);
  const other = makeRepo(t);
  writeMarker(repo, 'main');

  // ここでのヒアドキュメント本体は**実行されるコマンド**なので、データとして落としてはいけない。
  const command = ["bash <<'EOF'", `cd ${other}`, `${PR_CMD} --title t`, 'EOF'].join('\n');

  const r = runHook({ cwd: repo, command });
  assert.strictEqual(r.outcome, REMIND, 'シェルに渡すヒアドキュメントを素通りさせた');
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

  assert.strictEqual(r.outcome, REMIND, '本文ごと移動先まで落としている');
  assert.ok(context(r).includes(other), '解決した移動先が実際の移動先になっていない');
});

test('#68-7: ヒアドキュメントで本文ファイルを作ってから PR を作れる', (t) => {
  const repo = makeRepo(t);
  const wt = addWorktree(repo, 'feat-y', 'feature/y'); // 未経由

  // 本文に「行頭が移動コマンド」の手順が書かれている。行頭はコマンドの位置なので、
  // ヒアドキュメントの本体を落としていないと、これが移動先として採用される。
  // 移動先は実在しないので解決に失敗して黙り、cwd の worktree への注意書きが消える。
  const command = [
    "cat > /tmp/body.md <<'EOF'",
    '## 再現手順',
    'cd /nonexistent-repo-for-test',
    'EOF',
    `${PR_CMD} --title t --body-file /tmp/body.md`,
  ].join('\n');

  const r = runHook({ cwd: wt, command });
  assert.strictEqual(r.outcome, REMIND, `本文ファイルの中身を移動先として拾った\n${r.stdout}`);
  assert.ok(context(r).includes(wt), '注意書きの対象が cwd の worktree になっていない');
});

test('#68-8: 複数行にまたがる本文の行頭が移動先として解釈されない', (t) => {
  const repo = makeRepo(t);
  const wt = addWorktree(repo, 'feat-z', 'feature/z'); // 未経由

  // `--body` の値が実際の改行を含み、その行の1つが行頭から移動コマンドで始まる。
  // 切り出しが行単位だと PR 作成コマンドより後ろの行が残り、行頭は
  // コマンドの位置なので移動先として採用されてしまう（#68 と同じ失敗モードの別形態）。
  const body = ['line1', 'cd /nonexistent-xyz', 'line3'].join('\n');
  const r = runHook({ cwd: wt, command: `${PR_CMD} --title t --body "${body}"` });

  assert.strictEqual(r.outcome, REMIND, `複数行の本文の行頭を移動先として拾った\n${r.stdout}`);
  assert.ok(context(r).includes(wt), '注意書きの対象が cwd の worktree になっていない');
});

test('#68-9: 複数行でも、PR 作成コマンドより前の移動先は拾う', (t) => {
  const repo = makeRepo(t);
  const other = makeRepo(t);
  writeMarker(repo, 'main');

  // 切り出しを厳しくしすぎて、前にある本物の移動まで落とさないこと。
  const command = [`cd ${other}`, 'echo 準備', `${PR_CMD} --title t`].join('\n');
  const r = runHook({ cwd: repo, command });

  assert.strictEqual(r.outcome, REMIND, '複数行の本物の移動を見落とした');
});

test('#68-10: 移動先を解決できないとき、ブロックも注意書きもしない', (t) => {
  const repo = makeRepo(t);
  writeMarker(repo, 'main');

  // 変数は展開できないので必ず解決に失敗する。実際にこのセッションで踏んだ形。
  // 以前はここで exit 2 でブロックし、案内で回避策（絶対パス・--body-file）を示していた。
  // ブロックをやめたので、原因を利用者に直させる必要がなくなり、黙って通すのが正しい。
  const r = runHook({ cwd: repo, command: 'cd $OTHER && ' + PR_CMD });

  assert.strictEqual(r.status, 0, '移動先を解決できないだけで PR 作成が止められている');
  assert.strictEqual(r.outcome, SILENT);
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
    assert.strictEqual(r.outcome, REMIND, `キーワードの直後の移動を見落とした: ${command}`);
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

  assert.strictEqual(r.outcome, REMIND, 'クォート内の << をヒアドキュメントと誤認した');
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

  assert.strictEqual(r.outcome, SILENT, 'インデントされた終端で本体を打ち切っている');
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
    assert.strictEqual(r.outcome, REMIND, `${prefix} 経由の移動を見落とした`);
  }
});

// --- Issue #64: PR 作成は止めない ------------------------------------------------

test('#64: PR 作成は、どの状態でも exit 2 でブロックされない', (t) => {
  // 今までブロックしていた全パターンを並べ、「止めない」を不変条件として固定する。
  const repo = makeRepo(t);
  const other = makeRepo(t);
  const wt = addWorktree(repo, 'issue-64', 'fix/issue-64');
  writeMarker(repo, 'main');

  const commands = [
    [repo, PR_CMD],
    [repo, `cd ${other} && ${PR_CMD} --fill`],
    [repo, `bash -c "cd ${other} && ${PR_CMD} --fill"`],
    [repo, `cd ${wt} && ${PR_CMD} --fill`],
    [repo, `cd /nonexistent/xyz && ${PR_CMD}`],
    [repo, `cd $OTHER && ${PR_CMD}`],
    [mkdtemp(t), PR_CMD],
  ];
  for (const [cwd, command] of commands) {
    const r = runHook({ cwd, command });
    assert.equal(r.status, 0, `PR 作成が止められている: ${command}\n${r.stderr}`);
    assert.ok(!r.stdout.includes('permissionDecision'), `PR 作成に権限判定が付いた: ${command}`);
  }
});

test('#64: 注意書きは dev-ship 経由（マーカー一致）で消える', (t) => {
  const repo = makeRepo(t);
  git(repo, ['checkout', '-qb', 'feature/x']);
  assert.equal(runHook({ cwd: repo, command: PR_CMD }).outcome, REMIND);
  writeMarker(repo, 'feature/x');
  assert.equal(runHook({ cwd: repo, command: PR_CMD }).outcome, SILENT);
});

// --- Issue #64: PR マージは常に承認確認 ------------------------------------------

const MERGE_CMD = ['gh', 'pr', 'merge'].join(' ');

// GitHub MCP のうち、PR や base ブランチへ変更を入れるツール。クラウドは gh が無く MCP で操作する。
const MERGE_TOOLS = [
  'mcp__github__merge_pull_request',
  'mcp__github__enable_pr_auto_merge',
  'mcp__github__enqueue_pull_request',
  'mcp__github__merge_branch',
];
const NON_MERGE_TOOLS = [
  'mcp__github__create_pull_request',
  'mcp__github__update_pull_request',
  'mcp__sheets__merge_cells',
];

function askReason(res) {
  const out = JSON.parse(res.stdout).hookSpecificOutput;
  assert.equal(out.hookEventName, 'PreToolUse');
  assert.equal(out.permissionDecision, 'ask');
  assert.match(out.permissionDecisionReason, /承認/);
  return out.permissionDecisionReason;
}

test('#64: gh pr merge は承認確認になる（オプション・起動の形によらない）', (t) => {
  const repo = makeRepo(t);
  const other = makeRepo(t);
  for (const command of [
    MERGE_CMD,
    `${MERGE_CMD} 12`,
    `${MERGE_CMD} 12 --squash`,
    `${MERGE_CMD} 12 --rebase --delete-branch`,
    `${MERGE_CMD} 12 --merge`,
    `${MERGE_CMD} 12 --auto --squash`,
    `${MERGE_CMD} https://github.com/o/r/pull/12`,
    `/usr/bin/gh pr merge 12`,
    `GH_REPO=o/r ${MERGE_CMD} 12`,
    `cd ${other} && ${MERGE_CMD} 12`,
    `git push origin HEAD && ${MERGE_CMD} 12`,
    `bash -c "${MERGE_CMD} 12"`,
    `sh -c '${MERGE_CMD} 12'`,
    `eval "${MERGE_CMD} 12"`,
    ['bash <<\'EOF\'', MERGE_CMD + ' 12', 'EOF'].join('\n'),
  ]) {
    const r = runHook({ cwd: repo, command });
    assert.equal(r.outcome, ASK, `承認確認が出ない: ${command}`);
    askReason(r);
  }
});

test('#64: マージ API / GraphQL も承認確認になる（gh pr merge の迂回路）', (t) => {
  const repo = makeRepo(t);
  for (const command of [
    'gh api -X PUT repos/o/r/pulls/12/merge',
    'gh api --method PUT repos/o/r/pulls/12/merge -f merge_method=squash',
    // 引用符で URL を囲む書き方。クォート除去済みの文字列だけを見ていると URL ごと消えて素通りする。
    'gh api --method PUT "repos/o/r/pulls/12/merge" -f merge_method=squash',
    "gh api -X PUT 'repos/o/r/pulls/12/merge'",
    'curl -X PUT -H "Authorization: token $T" https://api.github.com/repos/o/r/pulls/12/merge',
    'gh api graphql -f query=\'mutation { mergePullRequest(input:{pullRequestId:"x"}) { clientMutationId } }\'',
    'gh api graphql -f query=\'mutation { enablePullRequestAutoMerge(input:{pullRequestId:"x"}) { clientMutationId } }\'',
    `bash -c "gh api -X PUT repos/o/r/pulls/12/merge"`,
  ]) {
    const r = runHook({ cwd: repo, command });
    assert.equal(r.outcome, ASK, `承認確認が出ない: ${command}`);
  }
});

test('#64: マージの承認確認は dev-ship のマーカーでは解除されない', (t) => {
  // マーカーは dev-ship / auto-build が自分で書く。これで解除できると skill の書き込みが承認になる。
  const repo = makeRepo(t);
  git(repo, ['checkout', '-qb', 'feature/x']);
  writeMarker(repo, 'feature/x');
  assert.equal(runHook({ cwd: repo, command: `${MERGE_CMD} 12` }).outcome, ASK);
  // 旧マーカー（.agent 配下）も同様
  fs.writeFileSync(path.join(repo, '.agent', '.dev-ship-active'), 'feature/x\n');
  assert.equal(runHook({ cwd: repo, command: `${MERGE_CMD} 12` }).outcome, ASK);
});

test('#64: マージの承認確認は .agent/ の有無・git 管理下かどうかに依らない', (t) => {
  const noAgent = makeRepo(t, { agent: false });
  assert.equal(runHook({ cwd: noAgent, command: `${MERGE_CMD} 12` }).outcome, ASK);
  assert.equal(runHook({ cwd: mkdtemp(t), command: `${MERGE_CMD} 12` }).outcome, ASK);
});

test('#64: MCP のマージ系ツールは承認確認になる（クラウドは gh が無く MCP で操作する）', (t) => {
  for (const tool of MERGE_TOOLS) {
    const r = runHook({ cwd: mkdtemp(t), tool, command: '' });
    assert.equal(r.outcome, ASK, `${tool}: 確認が出ない`);
    askReason(r);
  }
  for (const tool of NON_MERGE_TOOLS) {
    assert.notEqual(runHook({ cwd: mkdtemp(t), tool, command: '' }).outcome, ASK, `${tool}: 過剰に確認が出ている`);
  }
});

test('#64: マージ以外は承認確認にならない（PR 作成・閲覧・ローカルの git merge）', (t) => {
  const repo = makeRepo(t);
  writeMarker(repo, 'main');
  for (const command of [
    'gh pr view 12',
    'gh pr view 12 --json mergeable',
    'gh pr list --state merged',
    'gh pr checks 12',
    'gh pr create --fill', // PR 作成は止めない（マーカー一致なので注意書きも出ない）
    'gh pr create --title t --body-file b.md',
    'gh pr create --title t --body "$BODY"',
    'gh pr create --body-file $F',
    'gh pr view $N',
    'gh api repos/o/r/pulls/1 --jq .mergeable',
    'git merge feature/x', // ローカルの git merge は PR のマージではないので対象外
    'git status',
  ]) {
    const r = runHook({ cwd: repo, command });
    assert.notEqual(r.outcome, ASK, `過剰に承認確認が出ている: ${command}`);
  }
  assert.equal(
    runHook({ cwd: mkdtemp(t), tool: 'mcp__github__create_pull_request', command: '' }).outcome,
    SILENT,
    'MCP の PR 作成が承認確認になっている',
  );
});

test('#64: コミットメッセージ・Issue 本文に書いただけでも確認が出る（見落としより過剰確認を選ぶ）', (t) => {
  // クォートやヒアドキュメントを「データ」として消してから探す方式は、消す側とシェルの解釈がずれると
  // 検出対象ごと消える（下のバイパス群）。承認なしのマージは取り返しがつかないので、
  // 内容は消さずに探す。代償として、文字列を書いただけでも確認が1回出る。意図した挙動。
  const repo = makeRepo(t);
  for (const command of [
    `git commit -m "${MERGE_CMD} は呼ばない"`,
    'git commit -m "repos/o/r/pulls/12/merge を叩く"',
    ['gh issue create --title t --body-file - <<\'EOF\'', `手順: ${MERGE_CMD} 12`, 'EOF'].join('\n'),
  ]) {
    assert.equal(runHook({ cwd: repo, command }).outcome, ASK, `確認が出ない: ${command}`);
  }
});

test('#64: デコードして実行する・シェルへ流し込む構文は確認になる（文字列では検出できないため）', (t) => {
  // 実行されるコマンドがテキストに現れない。検出は構文そのものに対して行う。
  // 悪意のある回避に耐える境界ではなく、うっかりとよくある迂回を止める網（コメント参照）。
  const repo = makeRepo(t);
  for (const [label, command] of [
    ['base64 を復号してシェルへ', 'echo Z2ggcHIgbWVyZ2UgMQ== | base64 -d | sh'],
    ['base64 --decode を bash -c に渡す', 'bash -c "$(echo Z2ggcHIgbWVyZ2UgMQ== | base64 --decode)"'],
    ['printf の 16 進エスケープをシェルへ', "printf '\\x67\\x68 pr merge 1' | sh"],
    ['xxd -r をシェルへ', 'xxd -r -p <<< 676820707220206d65726765 | bash'],
    ['eval', 'eval "$CMD"'],
    ['インタプリタで文字コードから組んで実行', "python3 -c \"import os; os.system(chr(103)+chr(104)+' pr merge 1')\""],
  ]) {
    const r = runHook({ cwd: repo, command });
    assert.equal(r.outcome, ASK, `${label}: 確認が出ない: ${command}`);
    assert.match(askReason(r), /デコード|シェル/, `${label}: 理由が隠れた実行になっていない`);
  }
});

test('#64: 実行しても gh を引数なしで呼ぶだけの形は、マージとして扱わない', (t) => {
  // `gh$IFSpr$IFSmerge` は変数 $IFSpr と $IFSmerge（どちらも空）なので、実行されるのは `gh` だけ。
  const repo = makeRepo(t);
  assert.notEqual(runHook({ cwd: repo, command: 'gh$IFSpr$IFSmerge 1' }).outcome, ASK);
});

test('#64: 上の網は、日常のパイプ・インタプリタ起動には確認を出さない', (t) => {
  const repo = makeRepo(t);
  for (const command of [
    'echo hello | cat',
    'ls | grep foo',
    'jq . f.json | head',
    'cat f.json | python3 -m json.tool',
    'node --test x.test.js',
    'python3 -I script.py',
    'gh pr create --title "will merge later" --body x', // 作成コマンドの文言に merge があっても当たらない
  ]) {
    assert.notEqual(runHook({ cwd: repo, command }).outcome, ASK, `過剰に確認が出ている: ${command}`);
  }
});

test('#64: 検出を迂回できる書き方でも承認確認になる（セキュリティレビューの指摘10形態）', (t) => {
  const repo = makeRepo(t);
  const heredoc = (head, ...body) => [head, ...body, 'EOF'].join('\n');
  for (const [label, command] of [
    ['語の外側の引用符', `gh pr "merge" 12`],
    ['gh を引用符で囲む', `gh "pr" merge 12`],
    ['語の内側のバックスラッシュ', 'gh pr mer\\ge 12'],
    ['gh pr の直後にフラグ', `gh pr -R o/r merge 12`],
    ['--repo を挟む', `gh pr --repo o/r merge 12`],
    // エスケープされた引用符は引用の開始ではない。開始と誤認すると間の merge が消える。
    ['エスケープされた引用符で挟む', `echo it\\'s; ${MERGE_CMD} 1; echo 'x'`],
    ['エスケープされたダブルクォートで挟む', `echo \\"; ${MERGE_CMD} 1; echo \\"`],
    // 算術の << はヒアドキュメントではない。誤認すると以降の行が丸ごと落ちる。
    ['算術の << を挟む', heredoc('echo $((1 << EOF))', `${MERGE_CMD} 1`)],
    // 本体が実行される形はシェル直渡し（bash <<）だけではない。
    ['sh -s にヒアドキュメント', heredoc("sh -s <<'EOF'", `${MERGE_CMD} 1`)],
    ['インタプリタにヒアドキュメント', heredoc("python3 - <<'EOF'", 'import subprocess', 'subprocess.run(["gh","api","-X","PUT","repos/o/r/pulls/1/merge"])')],
    ['マージ API の番号が変数', 'gh api -X PUT repos/o/r/pulls/$N/merge'],
    ['マージ API の URL を文字列連結', "python3 -c \"import requests; requests.put(base + '/pulls/' + n + '/merge')\""],
    ['行継続での分割', 'gh pr \\\n merge 1'],
    // 2回目のセキュリティレビュー（解析のずれ / 検出対象の列挙漏れ）で実測した形
    ['merge の直後が空白でない', `${MERGE_CMD};echo`],
    ['サブシェル', `(${MERGE_CMD})`],
    ['&& が続く', `${MERGE_CMD}&&echo`],
    ['${IFS} で区切る', 'gh${IFS}pr${IFS}merge 1'],
    // `gh$IFSpr` は別の変数 $IFSpr なので区切りにならない。区切りになるのは、直後が識別子でない形
    ['$IFS で区切る（引用符で境界を作る）', "gh$IFS'pr'$IFS'merge' 1"],
    // $IFS_X は IFS とは別の変数。IFS として空白に置き換えると `$` が消えて動的な組み立てを見落とす
    ['IFS で始まる別名の変数をサブコマンドにする', 'M=merge; IFS_X=$M; gh pr $IFS_X 1'],
    // 5回目のレビュー: 展開が語の途中に入り、結果が空白か空かを実行前に決められない形
    ['${IFS:0:1} で区切る', 'gh${IFS:0:1}pr${IFS:0:1}merge 1'],
    ['${IFS%?} で区切る', 'gh${IFS%?}pr${IFS%?}merge 1'],
    ["$'\\t' で区切る", "gh$'\\t'pr$'\\t'merge 1"],
    ["$'\\x20' で区切る", "gh$'\\x20'pr$'\\x20'merge 1"],
    ['コマンド置換で空白を作る', 'gh$(printf " ")pr$(printf " ")merge 1'],
    ['バッククォートで空白を作る', 'gh`printf " "`pr merge 1'],
    ['既定値つき展開で空白を作る', 'gh${X:- }pr${X:- }merge 1'],
    ['pr の途中に展開', 'gh p${Z}r merge 1'],
    ['サブコマンドを変数に入れる', 'M=merge; gh pr $M 1'],
    ['サブコマンドをコマンド置換で作る', 'gh pr $(echo merge) 1'],
    ['サブコマンドをブレース展開で作る', 'gh pr {merge,} 1'],
    ['gh を変数に入れる', 'G=gh; $G pr merge 1'],
    ['ブランチ同士のマージ API', 'gh api repos/o/r/merges -f base=main -f head=feat'],
    ['ブランチ同士のマージ API（curl）', 'curl -X POST https://api.github.com/repos/o/r/merges -d "{}"'],
    ['auto-merge の予約（REST）', 'gh api -X PUT repos/o/r/pulls/1/auto-merge'],
    ['merge queue への投入（GraphQL）', "gh api graphql -f query='mutation{enqueuePullRequest(input:{pullRequestId:\"x\"}){clientMutationId}}'"],
    ['mergeBranch（GraphQL）', "gh api graphql -f query='mutation{mergeBranch(input:{}){x}}'"],
    ['hub merge', 'hub merge https://github.com/o/r/pull/1'],
    // 3回目のセキュリティレビュー（エンコードのずれ / 解析のずれ）で実測した形
    ['フラグの値に空白がある', 'gh pr --repo "my org/r" merge 1'],
    ['前半が読み取り系で後半がマージ', 'gh pr view 1 && gh pr --repo "a b" merge'],
    ['読み取り系の命令置換（バッククォート）の中', 'gh pr view `' + MERGE_CMD + ' 1`'],
    ['読み取り系の命令置換（$()）の中', 'gh pr view $(' + MERGE_CMD + ' 1)'],
    // バッククォートを消すと「読み取り系の区間」が閉じる位置を見失い、区間ごとマージが消える
    ['読み取り系の命令置換の中で、値に空白のあるフラグを付ける', 'gh pr view `gh pr --repo "a b" merge 1`'],
  ]) {
    assert.equal(runHook({ cwd: repo, command }).outcome, ASK, `${label}: 確認が出ない: ${command}`);
  }
});

// --- 登録（hooks.json）------------------------------------------------------------
// フック本体が正しくても、登録されていなければ一度も発火しない。exit 0 と区別できない失敗。

test('#64: hooks.json が Bash と MCP のマージ用 matcher でこのフックを登録している', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(__dirname, 'hooks.json'), 'utf8')).hooks.PreToolUse;
  const registered = (toolName) =>
    hooks.some(
      (h) =>
        new RegExp(`^(?:${h.matcher})$`).test(toolName) &&
        h.hooks.some((c) => c.command.includes('pre-pr-guard.sh')),
    );
  assert.ok(registered('Bash'), 'Bash でこのフックが発火しない');
  // フック本体が確認を出せても、登録されていなければ一度も呼ばれない。本体が ask を返す名前は
  // すべて登録側にも要る（片方だけ直すと、本体のテストが通ったまま発火しない）。
  for (const name of MERGE_TOOLS) {
    assert.ok(registered(name), `MCP の ${name} でこのフックが発火しない`);
  }
  for (const name of NON_MERGE_TOOLS) {
    assert.ok(!registered(name), `MCP の ${name} まで巻き込んでいる`);
  }
});
