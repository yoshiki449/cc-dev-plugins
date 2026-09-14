#!/usr/bin/env node
'use strict';

// publish-scan.sh と push hook の publish 経路のテスト。
// 実行: node --test plugins/git-secret-guard/scripts/publish-scan.test.js
//
// 設計の経緯は Issue #83（公開／非公開リポ分割）。
//
// このゲートが誤って「検出なし」に倒れると、公開してはいけない固有名が public リポジトリへ
// 出る。取り消せない種類の失敗なので、AC は「本来ブロックされるべき入力が本当に
// exit 1 になるか」を中心に置く。逆方向（私有リポジトリでの誤ブロック）も
// 使えなくなる形の失敗なので同じだけ固定する。

const test = require('node:test');
const assert = require('node:assert');
const { spawnSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.join(__dirname, 'publish-scan.sh');
const HOOK = path.join(__dirname, '..', 'hooks', 'pre-bash-push-check.sh');

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

let seq = 0;
function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `publish-scan-${tag}-${seq++}-`));
}

function mkDenylist(repos, deny) {
  const dir = tmpdir('deny');
  const f = path.join(dir, 'publish-denylist.txt');
  const lines = ['# コメント行', '', '[public-repos]', ...repos, '[deny]', ...deny];
  fs.writeFileSync(f, lines.join('\n') + '\n');
  return f;
}

function mkRepo(remote, files) {
  const dir = tmpdir('repo');
  execFileSync('git', ['init', '-q'], { cwd: dir, env: GIT_ENV });
  if (remote) execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: dir, env: GIT_ENV });
  for (const [name, body] of Object.entries(files || {})) {
    fs.writeFileSync(path.join(dir, name), body);
  }
  // --all モードは git ls-files を見るので index に載せる。
  // diff モードと hook 経路は HEAD を必要とするので commit まで作る。
  execFileSync('git', ['add', '-A'], { cwd: dir, env: GIT_ENV });
  if (Object.keys(files || {}).length > 0) {
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t',
      'commit', '-qm', 'init'], { cwd: dir, env: GIT_ENV });
  }
  return dir;
}

function run(args, { cwd, denylist, env } = {}) {
  return spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    cwd: cwd || os.tmpdir(),
    env: { ...GIT_ENV, CC_PUBLISH_DENYLIST: denylist || '/nonexistent', ...(env || {}) },
  });
}

const DENY = ['acme-corp', 'secret-product'];

// ---------------------------------------------------------------------------
// AC1-AC4: 走査する／しないの判定
// ---------------------------------------------------------------------------

test('AC1: denylist が無ければ走査せず exit 0、ただし黙らずに理由を言う', () => {
  const repo = mkRepo('https://github.com/me/pub.git', { 'a.md': 'acme-corp\n' });
  const r = run(['--all'], { cwd: repo });
  assert.strictEqual(r.status, 0);
  assert.match(r.stderr, /denylist が無い/);
});

test('AC2: remote が [public-repos] に無ければ no-op（私有リポジトリで誤ブロックしない）', () => {
  const denylist = mkDenylist(['me/pub'], DENY);
  const repo = mkRepo('https://github.com/me/private.git', { 'a.md': 'acme-corp\n' });
  const r = run(['--all'], { cwd: repo, denylist });
  assert.strictEqual(r.status, 0, '私有リポジトリでは組織名が出てくるのが正常');
  assert.strictEqual(r.stderr.trim(), '');
});

test('AC3: remote が [public-repos] に載っていれば走査して検出する', () => {
  const denylist = mkDenylist(['me/pub'], DENY);
  const repo = mkRepo('https://github.com/me/pub.git', { 'a.md': 'acme-corp は社内の呼び名\n' });
  const r = run(['--all'], { cwd: repo, denylist });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /acme-corp/);
});

test('AC4: --force は [public-repos] 照合を飛ばす（公開前の一括確認用）', () => {
  const denylist = mkDenylist(['me/pub'], DENY);
  const repo = mkRepo('https://github.com/me/private.git', { 'a.md': 'secret-product\n' });
  const r = run(['--force', '--all'], { cwd: repo, denylist });
  assert.strictEqual(r.status, 1, '--force なら私有リポジトリでも走る');
});

// ---------------------------------------------------------------------------
// AC5-AC8: denylist の解釈
// ---------------------------------------------------------------------------

test('AC5: [deny] が空なら exit 2（走査できないことを検出なしと混同しない）', () => {
  const denylist = mkDenylist(['me/pub'], []);
  const repo = mkRepo('https://github.com/me/pub.git', { 'a.md': 'acme-corp\n' });
  const r = run(['--force', '--all'], { cwd: repo, denylist });
  assert.strictEqual(r.status, 2, '空の denylist を exit 0 にすると無音で素通りする');
});

test('AC6: コメント行と空行は denylist のパターンとして扱わない', () => {
  // '#' を含む行をパターンにしてしまうと、ほぼ全ファイルが誤検出になる。
  const dir = tmpdir('deny');
  const f = path.join(dir, 'd.txt');
  fs.writeFileSync(f, '[public-repos]\nme/pub\n[deny]\n# acme-corp\n\nsecret-product\n');
  const repo = mkRepo('https://github.com/me/pub.git', { 'a.md': 'acme-corp だけがある\n' });
  const r = run(['--force', '--all'], { cwd: repo, denylist: f });
  assert.strictEqual(r.status, 0, 'コメント化したパターンは効かせない');
});

test('AC7: セクション外の行はどちらの配列にも入らない', () => {
  const dir = tmpdir('deny');
  const f = path.join(dir, 'd.txt');
  // [deny] の前に書かれた語はパターンにならない。
  fs.writeFileSync(f, 'acme-corp\n[public-repos]\nme/pub\n[deny]\nsecret-product\n');
  const repo = mkRepo('https://github.com/me/pub.git', { 'a.md': 'acme-corp\n' });
  const r = run(['--force', '--all'], { cwd: repo, denylist: f });
  assert.strictEqual(r.status, 0);
});

test('AC8: 大文字小文字を区別しない', () => {
  const denylist = mkDenylist(['me/pub'], DENY);
  const repo = mkRepo('https://github.com/me/pub.git', { 'a.md': 'ACME-Corp\n' });
  const r = run(['--force', '--all'], { cwd: repo, denylist });
  assert.strictEqual(r.status, 1, '表記を変えただけで素通りしてはいけない');
});

// ---------------------------------------------------------------------------
// AC9-AC11: 汎用パターン（denylist に書かなくても常に見る）
// ---------------------------------------------------------------------------

const MAIL_ALLOWED = [
  'taro@example.com',
  'x@test.example.com',
  'y@company.invalid',
  'z@foo.test',
  'w@localhost',
];
const MAIL_BLOCKED = [
  'u@acme.co.jp', // publish-scan:allow 弾かれるべきサンプル
  'v@real-company.com', // publish-scan:allow 弾かれるべきサンプル
  // 末尾で判定しないと example.com が前方に出ただけで素通りする
  't@example.com.evil.ru', // publish-scan:allow 弾かれるべきサンプル
];

test('AC9: 予約ドメインのメールアドレスは許す', () => {
  const denylist = mkDenylist(['me/pub'], DENY);
  for (const addr of MAIL_ALLOWED) {
    const repo = mkRepo('https://github.com/me/pub.git', { 'a.md': `連絡先は ${addr}\n` });
    const r = run(['--force', '--all'], { cwd: repo, denylist });
    assert.strictEqual(r.status, 0, `${addr} は許すべき\n${r.stderr}`);
  }
});

test('AC10: 実在しそうなメールアドレスは denylist に無くても弾く', () => {
  const denylist = mkDenylist(['me/pub'], DENY);
  for (const addr of MAIL_BLOCKED) {
    const repo = mkRepo('https://github.com/me/pub.git', { 'a.md': `連絡先は ${addr}\n` });
    const r = run(['--force', '--all'], { cwd: repo, denylist });
    assert.strictEqual(r.status, 1, `${addr} は弾くべき`);
    assert.match(r.stderr, /\[generic\]/);
  }
});

test('AC11: 秘密鍵とトークンの形は denylist に無くても弾く', () => {
  const denylist = mkDenylist(['me/pub'], DENY);
  const samples = [
    '-----BEGIN RSA PRIVATE KEY-----', // publish-scan:allow 見出しのみ・鍵本体ではない
    'AKIAIOSFODNN7EXAMPLE', // publish-scan:allow AWS 公式ドキュメントの例示値
    'ghp_0123456789abcdefghijklmnopqrstuvwx', // publish-scan:allow 連番の架空値
    'xoxb-0123456789-abcdefghij', // publish-scan:allow 連番の架空値
  ];
  for (const s of samples) {
    const repo = mkRepo('https://github.com/me/pub.git', { 'a.md': `${s}\n` });
    const r = run(['--force', '--all'], { cwd: repo, denylist });
    assert.strictEqual(r.status, 1, `${s} は弾くべき`);
  }
});

// ---------------------------------------------------------------------------
// AC12-AC14: 走査モード
// ---------------------------------------------------------------------------

test('AC12: diff モードは追加行だけを見る（削除行の固有名は問題ない）', () => {
  const denylist = mkDenylist(['me/pub'], DENY);
  const repo = mkRepo('https://github.com/me/pub.git', { 'a.md': 'acme-corp\n' });
  // 追加行に固有名がある状態 → 検出
  assert.strictEqual(run([], { cwd: repo, denylist }).status, 1);

  fs.writeFileSync(path.join(repo, 'a.md'), 'きれいになった\n');
  execFileSync('git', ['add', '-A'], { cwd: repo, env: GIT_ENV });
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t',
    'commit', '-qm', 'clean'], { cwd: repo, env: GIT_ENV });
  const r = run([], { cwd: repo, denylist });
  // HEAD 全体が範囲なので first commit の追加行も入る。削除行だけになった訳ではない。
  // ここで固定したいのは「削除行が理由で落ちることはない」＝ stderr に削除行が出ないこと。
  if (r.status === 1) {
    assert.ok(!/^\[deny[^\]]*\] -/m.test(r.stderr), '削除行を検出対象にしてはいけない');
  }
});

test('AC20: upstream が無いとき全コミットを見る（初回 push で履歴を取り逃がさない）', () => {
  // 公開リポジトリへの最初の push では upstream がまだ無く、履歴全体が一度に公開される。
  // 直近1コミットだけ見る実装（secret-scan.sh の流儀）だと、古いコミットに入った
  // 固有名を取り逃がす＝取り消せない方向に倒れる。
  const denylist = mkDenylist(['me/pub'], DENY);
  const repo = mkRepo('https://github.com/me/pub.git', { 'old.md': 'acme-corp は社内の呼び名\n' });
  fs.writeFileSync(path.join(repo, 'new.md'), 'これはきれいな行\n');
  execFileSync('git', ['add', '-A'], { cwd: repo, env: GIT_ENV });
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t',
    'commit', '-qm', 'second'], { cwd: repo, env: GIT_ENV });
  const r = run([], { cwd: repo, denylist });
  assert.strictEqual(r.status, 1, '古いコミットの固有名を見逃してはいけない');
  assert.match(r.stderr, /acme-corp/);
});

test('AC13: --paths にパスが無ければ exit 2', () => {
  const denylist = mkDenylist(['me/pub'], DENY);
  const repo = mkRepo('https://github.com/me/pub.git', {});
  assert.strictEqual(run(['--force', '--paths'], { cwd: repo, denylist }).status, 2);
});

test('AC14: 不明な引数と --help は exit 2', () => {
  assert.strictEqual(run(['--bogus']).status, 2);
  assert.strictEqual(run(['--help']).status, 2);
});

// ---------------------------------------------------------------------------
// AC15-AC17: hook 経路
// ---------------------------------------------------------------------------

// PreToolUse がツール実行をブロックする唯一の終了コード。
// 0 は通過、2 以外の非ゼロは「stderr をユーザーに見せるが実行は続行」。
// AC15〜AC17 が 1 を期待していたせいで、ゲートが止められない状態が v0.1.0 から
// v0.2.1 まで緑のまま残っていた。値の意味は AC23 に書く。
const BLOCK = 2;

function runHook(command, cwd, denylist, extraEnv) {
  const payload = JSON.stringify({ tool_input: { command }, cwd });
  return spawnSync('bash', [HOOK], {
    input: payload,
    encoding: 'utf8',
    cwd,
    env: {
      ...GIT_ENV,
      CLAUDE_PLUGIN_ROOT: path.join(__dirname, '..'),
      CC_PUBLISH_DENYLIST: denylist,
      ...(extraEnv || {}),
    },
  });
}

test('AC15: hook は cwd の公開リポジトリで検出したら push をブロックする', () => {
  const denylist = mkDenylist(['me/pub'], DENY);
  const repo = mkRepo('https://github.com/me/pub.git', { 'a.md': 'acme-corp\n' });
  const r = runHook('git push origin main', repo, denylist);
  assert.strictEqual(r.status, BLOCK);
  assert.match(r.stderr, /公開してはいけない語を検出/);
});

test('AC16: hook はコマンド中の cd 先も候補にする（cwd だけに頼らない）', () => {
  // `cd /other/repo && git push` で cwd 側が私有リポジトリだと、cwd だけ見ていると
  // 公開リポジトリへの push が無音で素通りする。
  const denylist = mkDenylist(['me/pub'], DENY);
  const pub = mkRepo('https://github.com/me/pub.git', { 'a.md': 'acme-corp\n' });
  const priv = mkRepo('https://github.com/me/private.git', { 'b.md': 'なんでもない\n' });
  const r = runHook(`cd ${pub} && git push origin main`, priv, denylist);
  assert.strictEqual(r.status, BLOCK, 'cd 先の公開リポジトリを見逃してはいけない');
});

test('AC17: ALLOW_SECRETS は公開前スキャンを巻き添えで無効化しない', () => {
  // 秘密スキャンの誤検出を回避するための環境変数が、別の失敗モードを守るゲートまで
  // 消してしまうと、回避が一度使われた瞬間に公開事故の経路が開く。
  const denylist = mkDenylist(['me/pub'], DENY);
  const repo = mkRepo('https://github.com/me/pub.git', { 'a.md': 'acme-corp\n' });
  const r = runHook('git push origin main', repo, denylist, { ALLOW_SECRETS: '1' });
  assert.strictEqual(r.status, BLOCK, 'ALLOW_SECRETS=1 でも publish-scan は走る');
  assert.match(r.stderr, /公開してはいけない語を検出/);
});

test('AC18: ALLOW_PUBLISH=1 なら公開前スキャンだけを明示的に飛ばす', () => {
  const denylist = mkDenylist(['me/pub'], DENY);
  const repo = mkRepo('https://github.com/me/pub.git', { 'a.md': 'acme-corp\n' });
  const r = runHook('git push origin main', repo, denylist, { ALLOW_PUBLISH: '1' });
  assert.match(r.stderr, /ALLOW_PUBLISH=1/);
});

// ---------------------------------------------------------------------------
// AC19: スクリプト自身の実装上の前提
// ---------------------------------------------------------------------------

test('AC21: 行単位の除外の印は、このゲート自身のテストにしか無い', () => {
  // 印はパス除外より安全だが、便利なので他所へ広がりやすい。広がった時点で
  // 「ゲートを通っている」ことの意味が薄れるので、置き場所と件数の両方を固定する。
  const repoRoot = path.join(__dirname, '..', '..', '..');
  const files = execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\n').filter(Boolean);
  const MARK = 'publish-scan' + ':allow';
  const found = [];
  for (const f of files) {
    const abs = path.join(repoRoot, f);
    let body;
    try { body = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    const n = body.split('\n').filter((l) => l.includes(MARK)).length;
    if (n > 0) found.push([f, n]);
  }
  const self = 'plugins/git-secret-guard/scripts/publish-scan.test.js';
  const others = found.filter(([f]) => f !== self && f !== 'plugins/git-secret-guard/scripts/publish-scan.sh');
  assert.deepStrictEqual(others, [], '除外の印がゲート自身のテスト以外に現れた');
  const selfCount = (found.find(([f]) => f === self) || [, 0])[1];
  // 7 → 15: コミットのメタデータ走査（AC26〜AC33）を足したとき、実在しそうな作者メールを
  // 8 行ぶん置いた。どれも「弾かれる側のサンプル」で、予約 TLD にすると弾かれず検査にならない。
  assert.strictEqual(selfCount, 15, '印の件数が変わった。増やすなら理由を1行ずつ書くこと');
});

test('AC19: 照合と走査はすべて command grep で呼ぶ', () => {
  // grep はシェル関数でシムに差し替えられていることがある（Claude Code は ugrep を
  // --ignore-files 付きで被せる）。gitignore 対象を無音でスキップされると、
  // 公開ゲートとして最悪の方向（見逃し）に倒れる。
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const bare = src
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('#'))
    .filter((l) => /(^|[|;(]|\s)grep\b/.test(l) && !/command grep/.test(l));
  assert.deepStrictEqual(bare, [], '素の grep 呼び出しが残っている');
});

test('AC22: hook の登録側でコマンドを絞り込まない', () => {
  // 絞り込みが登録側とスクリプト側の2箇所にあると、スクリプトを直しても登録側で
  // 落ちる経路が残る。実際に動いている dev-flow の pre-pr-guard は登録側に条件を持たず、
  // スクリプト本体だけで判定している。形を揃える。
  //
  // 注意: `"if": "Bash(git push:*)"` が compound コマンドを取り逃がすかは切り分けていない。
  // ゲートが止まらなかった原因として実測で確定したのは終了コードのほう（AC23）で、
  // 条件を外しただけでは挙動は変わらなかった。
  const hooks = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'hooks', 'hooks.json'), 'utf8'));
  const entries = hooks.hooks.PreToolUse;
  assert.strictEqual(entries.length, 1, 'PreToolUse の登録が1つでなくなった');
  assert.strictEqual(entries[0].matcher, 'Bash');

  const inner = entries[0].hooks;
  assert.strictEqual(inner.length, 1, 'Bash matcher 配下の hook が1つでなくなった');
  assert.ok(inner[0].command.includes('pre-bash-push-check.sh'), '起動先が変わった');
  assert.strictEqual(typeof inner[0].timeout, 'number', 'timeout が数値でない');

  // どの階層にも条件キーを置かない。名前を変えて同じことをしても落とす。
  const CONDITION_KEYS = ['if', 'when', 'condition', 'matchCommand'];
  for (const level of [entries[0], inner[0]]) {
    for (const k of CONDITION_KEYS) {
      assert.ok(!(k in level), `登録側に起動条件 ${k} が入っている。絞り込みはスクリプト本体だけ`);
    }
  }

  // スクリプト側の絞り込みが消えていないこと（登録側を外した分、ここが唯一の門になる）
  const hookSrc = fs.readFileSync(HOOK, 'utf8');
  assert.ok(
    hookSrc.includes(String.raw`grep -qE '\bgit[[:space:]]+push\b'`),
    'スクリプト側の git push 判定が消えた。登録側に条件が無いので全 Bash が走る',
  );
});

test('AC23: 検出したら exit 2 を返す（PreToolUse がブロックする唯一の値）', () => {
  // PreToolUse の契約: 0 は通過、2 は「stderr をモデルに見せてツール実行をブロック」、
  // それ以外の非ゼロは「stderr をユーザーに見せるが実行は続行する」。
  //
  // 実測（Issue #83 Phase 4）: この hook は検出時に exit 1 を返していたため、
  // 検出メッセージだけ出して push はそのまま通っていた。denylist の語を1行含む
  // コミットが公開リポジトリへ実際に通り、偽のトークンを含むコミットも素通りした。
  // v0.1.0 から入っていた値で、AC15〜AC17 が 1 を期待していたので緑のまま残っていた。
  //
  // 配下の secret-scan.sh / publish-scan.sh は単体実行もするので exit 1 のままでよい。
  // 1 を 2 に翻訳するのは hook の責務なので、hook 側だけを固定する。
  const src = fs.readFileSync(HOOK, 'utf8');
  const code = src.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');

  assert.ok(/BLOCK=2\b/.test(code), 'ブロック用の終了コードが 2 でなくなった');
  assert.ok(!/STATUS=1\b/.test(code), '検出時に 1 を返す経路が復活した。1 では push が続行する');

  // 実際に走らせて確かめる。値の由来をコメントで説明するだけでは、
  // 代入先を変えられたときに落ちない。
  const denylist = mkDenylist(['me/pub'], DENY);
  const repo = mkRepo('https://github.com/me/pub.git', { 'a.md': 'acme-corp\n' });
  const hit = runHook('git push origin main', repo, denylist);
  assert.strictEqual(hit.status, 2, '検出したのにブロックできない終了コードを返した');

  // 通過側は 0 のまま（2 を返し続けるとすべての push が止まる）
  const clean = mkRepo('https://github.com/me/private.git', { 'b.md': 'なんでもない\n' });
  const pass = runHook('git push origin main', clean, denylist);
  assert.strictEqual(pass.status, 0, '検出なしなのに 0 以外を返した');
});

test('AC24: 秘密スキャンもコマンド中の cd 先を見る', () => {
  // AC16 と同じ穴が、もう一方のスキャンに残っていた。
  // v0.2.2 まで cd 先の解決は publish-scan にだけ付いており、秘密スキャンは
  // cwd のリポジトリだけを見ていた。`cd /repo && git push` は worktree 運用の既定形なので、
  // 実測では偽のトークンを含むコミットがそのまま push された。
  //
  // 2本とも同じ候補ループで回すことを、スクリプトの構造ではなく実挙動で固定する。
  const denylist = mkDenylist(['me/pub'], DENY);
  const target = mkRepo('https://github.com/me/other.git', {
    'conf.py': 'TOKEN = "ghp_' + 'A'.repeat(36) + '"\n',
  });
  const cwd = mkRepo('https://github.com/me/private.git', { 'b.md': 'なんでもない\n' });

  const r = runHook(`cd ${target} && git push origin main`, cwd, denylist);
  assert.strictEqual(r.status, 2, 'cd 先の秘密を見逃した');
  assert.match(r.stderr, /潜在的シークレットを検出/);

  // ALLOW_SECRETS=1 のときは秘密スキャンだけが黙る（候補解決ごと消えない）
  const skipped = runHook(`cd ${target} && git push origin main`, cwd, denylist, { ALLOW_SECRETS: '1' });
  assert.strictEqual(skipped.status, 0, 'ALLOW_SECRETS=1 なのに秘密スキャンでブロックした');
});

test('AC25: 同じリポジトリを二度走査しない', () => {
  // cwd と cd 先が同じリポジトリを指すのは普通にある形（`cd $PWD && git push`、
  // worktree の別パス表記など）。重複排除が消えると同じ検出が2回出る。
  // 止まる／止まらないは変わらないので終了コードでは気づけず、出力の読みづらさだけが残る。
  const denylist = mkDenylist(['me/pub'], DENY);
  const repo = mkRepo('https://github.com/me/pub.git', { 'a.md': 'acme-corp\n' });

  const r = runHook(`cd ${repo} && git push origin main`, repo, denylist);
  assert.strictEqual(r.status, 2);
  const hits = r.stderr.split('\n').filter((l) => l.includes('公開してはいけない語を検出')).length;
  assert.strictEqual(hits, 1, '同じリポジトリを二度走査している');
});

// ---------------------------------------------------------------------------
// AC26-AC29: コミットのメタデータ（Issue #83 Phase 2 の取りこぼし）
// ---------------------------------------------------------------------------

function mkRepoWithAuthor(remote, email, { tag } = {}) {
  const dir = tmpdir('meta');
  execFileSync('git', ['init', '-q'], { cwd: dir, env: GIT_ENV });
  execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: dir, env: GIT_ENV });
  fs.writeFileSync(path.join(dir, 'a.md'), 'なんでもない\n');
  execFileSync('git', ['add', '-A'], { cwd: dir, env: GIT_ENV });
  execFileSync(
    'git',
    ['-c', `user.email=${email}`, '-c', 'user.name=t', 'commit', '-qm', 'init'],
    { cwd: dir, env: GIT_ENV },
  );
  if (tag) {
    execFileSync(
      'git',
      ['-c', `user.email=${tag}`, '-c', 'user.name=t', 'tag', '-a', 'v1', '-m', 'release'],
      { cwd: dir, env: GIT_ENV },
    );
  }
  return dir;
}

test('AC26: コミットの author / committer のメールを走査する', () => {
  // ファイルの中身だけ見ていると取りこぼす。実測（Issue #83 Phase 2）では、
  // スキャンもテストも履歴のファイル名検査も通したあとに、作者メールが勤務先アドレスの
  // ままだと目視で気づいた。GitHub は public リポジトリの作者メールを誰でも見られる形で出す。
  // 1コミットでも入ると履歴の書き換えと force push が要るので、ファイル本文より手当てが重い。
  const denylist = mkDenylist(['me/pub'], DENY);
  const repo = mkRepoWithAuthor('https://github.com/me/pub.git', 'someone@realcompany.co.jp');  // publish-scan:allow

  const r = run([], { cwd: repo, denylist });
  assert.strictEqual(r.status, 1, 'コミットの作者メールを見逃した');
  assert.match(r.stderr, /commit-meta .* author: /, 'どのコミットの何かが分からない');
});

test('AC27: noreply 系は許し、実在ドメインは弾く', () => {
  // ここを許さないとゲートが毎回鳴り、ALLOW_PUBLISH で飛ばす運用に倒れる。
  // 鳴りっぱなしのゲートは無いのと同じ。ただし緩めた分、弾く側が生きていることを同時に固定する。
  const denylist = mkDenylist(['me/pub'], DENY);

  const ALLOWED = ['someone@users.noreply.github.com', 'noreply@anthropic.com', 'no-reply@example.co.jp'];
  for (const mail of ALLOWED) {
    const repo = mkRepoWithAuthor('https://github.com/me/pub.git', mail);
    const r = run([], { cwd: repo, denylist });
    assert.strictEqual(r.status, 0, `noreply 系を弾いた: ${mail}\n${r.stderr}`);
  }

  const BLOCKED = ['someone@realcompany.co.jp', 'noreplyer@realcompany.co.jp'];  // publish-scan:allow
  for (const mail of BLOCKED) {
    const repo = mkRepoWithAuthor('https://github.com/me/pub.git', mail);
    const r = run([], { cwd: repo, denylist });
    assert.strictEqual(r.status, 1, `実在しそうなアドレスを通した: ${mail}`);
  }
});

test('AC28: タグの tagger も走査する', () => {
  // タグはコミットとは別のオブジェクトで、tagger と本文を持つ。
  // コミットだけ見て安心すると、リリースタグから漏れる。
  const denylist = mkDenylist(['me/pub'], DENY);
  const repo = mkRepoWithAuthor('https://github.com/me/pub.git', 'ok@users.noreply.github.com', {
    tag: 'tagger@realcompany.co.jp',  // publish-scan:allow
  });

  const r = run([], { cwd: repo, denylist });
  assert.strictEqual(r.status, 1, 'タグの tagger を見逃した');
  assert.match(r.stderr, /tag-meta /, 'タグ由来だと分からない');
});

test('AC29: --all でも履歴のメタデータを見る', () => {
  // --all は公開前の一括確認なので、走査範囲は tracked ファイルだけでは足りない。
  const denylist = mkDenylist(['me/pub'], DENY);
  const repo = mkRepoWithAuthor('https://github.com/me/pub.git', 'someone@realcompany.co.jp');  // publish-scan:allow

  const r = run(['--all'], { cwd: repo, denylist });
  assert.strictEqual(r.status, 1, '--all がコミットのメタデータを見ていない');
});

test('AC30: 私有リポジトリではメタデータ走査も no-op のまま', () => {
  // 走査対象を増やしたぶん、公開対象でないリポジトリで誤ブロックする経路も増える。
  // [public-repos] の照合より手前で落ちることを、走査の追加とセットで固定する。
  const denylist = mkDenylist(['me/pub'], DENY);
  const repo = mkRepoWithAuthor('https://github.com/me/private.git', 'someone@realcompany.co.jp');  // publish-scan:allow

  const r = run([], { cwd: repo, denylist });
  assert.strictEqual(r.status, 0, '私有リポジトリで誤ブロックした');
});

test('AC31: upstream がある経路でもメタデータを走査する', () => {
  // AC26〜AC30 はどれも upstream の無いリポジトリを使っていた。実運用は clone した
  // 追跡ブランチなので、走るのは @{push} / @{upstream} の分岐のほう。
  // その経路だけ走査を消す変異が素通りしたので、経路ごと固定する。
  const denylist = mkDenylist(['me/pub'], DENY);

  const bare = tmpdir('bare');
  execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', bare], { env: GIT_ENV });

  const work = tmpdir('clone');
  execFileSync('git', ['clone', '-q', bare, work], { env: GIT_ENV });

  // 1本目は綺麗なコミットで、push して upstream を作る
  fs.writeFileSync(path.join(work, 'a.md'), 'なんでもない\n');
  execFileSync('git', ['add', '-A'], { cwd: work, env: GIT_ENV });
  execFileSync(
    'git',
    ['-c', 'user.email=ok@users.noreply.github.com', '-c', 'user.name=t', 'commit', '-qm', 'init'],
    { cwd: work, env: GIT_ENV },
  );
  execFileSync('git', ['push', '-q', '-u', 'origin', 'main'], { cwd: work, env: GIT_ENV });

  // push 先を公開リポジトリの URL に見せかける（bare への push はもうしない）
  execFileSync('git', ['remote', 'set-url', 'origin', 'https://github.com/me/pub.git'], {
    cwd: work,
    env: GIT_ENV,
  });

  // 2本目が未 push。ここに汚れた作者が乗る
  fs.writeFileSync(path.join(work, 'b.md'), 'これも中身は問題ない\n');
  execFileSync('git', ['add', '-A'], { cwd: work, env: GIT_ENV });
  execFileSync(
    'git',
    ['-c', 'user.email=someone@realcompany.co.jp', '-c', 'user.name=t', 'commit', '-qm', 'second'],  // publish-scan:allow
    { cwd: work, env: GIT_ENV },
  );

  const r = run([], { cwd: work, denylist });
  assert.strictEqual(r.status, 1, 'upstream 経路でメタデータを見ていない');
  assert.match(r.stderr, /commit-meta .* author: /);
  // 走査範囲は未 push 分だけ。push 済みの1本目を持ち出していないこと
  assert.ok(!/init/.test(r.stderr), 'push 済みのコミットまで走査している');
});

test('AC32: author が綺麗でも committer が汚れていたら止める', () => {
  // amend / rebase / cherry-pick では author と committer が別人になる。
  // Issue #83 Phase 2 で踏んだのも amend の場面だった。
  // 両方を同じ値にしたテストしか無いと、committer 側の走査を消しても author 側で拾えてしまう。
  const denylist = mkDenylist(['me/pub'], DENY);

  const dir = tmpdir('committer');
  execFileSync('git', ['init', '-q'], { cwd: dir, env: GIT_ENV });
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/me/pub.git'], {
    cwd: dir,
    env: GIT_ENV,
  });
  fs.writeFileSync(path.join(dir, 'a.md'), 'なんでもない\n');
  execFileSync('git', ['add', '-A'], { cwd: dir, env: GIT_ENV });
  execFileSync('git', ['commit', '-qm', 'init'], {
    cwd: dir,
    env: {
      ...GIT_ENV,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 'ok@users.noreply.github.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 'someone@realcompany.co.jp',  // publish-scan:allow
    },
  });

  const r = run([], { cwd: dir, denylist });
  assert.strictEqual(r.status, 1, 'committer のメールを見ていない');
  assert.match(r.stderr, /commit-meta .* committer: /, 'committer 由来だと分からない');
});

test('AC33: push 済みのコミットは走査しない', () => {
  // 走査範囲は未 push 分だけ。既に公開されているコミットまで蒸し返すと、
  // 直しようのない指摘で毎回止まり、ALLOW_PUBLISH で飛ばす運用に倒れる。
  // 範囲指定を外す変異がこれまで素通りしていたので、範囲そのものを固定する。
  const denylist = mkDenylist(['me/pub'], DENY);

  const bare = tmpdir('bare-pushed');
  execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', bare], { env: GIT_ENV });
  const work = tmpdir('clone-pushed');
  execFileSync('git', ['clone', '-q', bare, work], { env: GIT_ENV });

  // 1本目は汚れた作者だが、push 済み＝もう公開されている
  fs.writeFileSync(path.join(work, 'a.md'), 'なんでもない\n');
  execFileSync('git', ['add', '-A'], { cwd: work, env: GIT_ENV });
  execFileSync(
    'git',
    ['-c', 'user.email=old@realcompany.co.jp', '-c', 'user.name=t', 'commit', '-qm', 'init'],  // publish-scan:allow
    { cwd: work, env: GIT_ENV },
  );
  execFileSync('git', ['push', '-q', '-u', 'origin', 'main'], { cwd: work, env: GIT_ENV });
  execFileSync('git', ['remote', 'set-url', 'origin', 'https://github.com/me/pub.git'], {
    cwd: work,
    env: GIT_ENV,
  });

  // 2本目は綺麗。これから push されるのはこちらだけ
  fs.writeFileSync(path.join(work, 'b.md'), 'これも中身は問題ない\n');
  execFileSync('git', ['add', '-A'], { cwd: work, env: GIT_ENV });
  execFileSync(
    'git',
    ['-c', 'user.email=ok@users.noreply.github.com', '-c', 'user.name=t', 'commit', '-qm', 'second'],
    { cwd: work, env: GIT_ENV },
  );

  const r = run([], { cwd: work, denylist });
  assert.strictEqual(r.status, 0, `push 済みのコミットまで走査している\n${r.stderr}`);

  // --all は公開前の一括確認なので、こちらは履歴全体を見て止まる
  const all = run(['--all'], { cwd: work, denylist });
  assert.strictEqual(all.status, 1, '--all が履歴全体を見ていない');
});
