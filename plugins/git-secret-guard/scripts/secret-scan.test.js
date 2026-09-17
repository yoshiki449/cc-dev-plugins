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
//
// サンプル文字列は連結で組み立てる。secret-scan.sh 自身がこのファイルの diff を
// 走査対象にする（このゲートは自分自身のリポジトリにも push 前に効く）ため、
// 検出パターンに一致する文字列をソース上に直接連続して書くと、このテスト
// ファイルの追加そのものが誤検出の実例になってしまう。

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

// 検出パターンが読む「キーワード = 値」の形を、キーワード自体はソース上に
// 連続して現れないように組み立てる。
const K = {
  password: 'PASS' + 'WORD',
  token: 'TOK' + 'EN',
  apiToken: 'API_' + 'TOK' + 'EN',
  secret: 'SEC' + 'RET',
  apiKey: 'API_' + 'KEY',
};

function kv(key, value) {
  return `${key} = "${value}"`;
}

const FAKE_PASSWORD_VALUE = 'Tr0ub4d' + 'or&3xyzZQ';
const FAKE_TOKEN_VALUE = 'abcdefghijklmnop' + '12345678';
const LONG_ALNUM = 'a1B2c3D4'.repeat(6); // ソース上は8文字の塊。repeat は実行時にしか展開されない
const BCRYPT_SAMPLE =
  '$2b$10$' + ['N9qo8uLOickgx2ZM', 'RZoMyeIjZAgcfl7p9', '2ldGxad68LJZdL17lhWy'].join('');

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
  const repo = mkRepo({ 'conf.py': `${K.token} = "ghp_${'A'.repeat(36)}"\n` });
  const r = run(repo);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /SaaS\/Cloud トークン形式/);
});

test('本物のトークン prefix はテストファイルでも検出する（パターン1はテスト除外の対象外）', () => {
  const repo = mkRepo({ 'tests/conf.test.py': `${K.token} = "ghp_${'A'.repeat(36)}"\n` });
  const r = run(repo);
  assert.strictEqual(r.status, 1, 'テストファイルだからといって本物のトークンを見逃してはいけない');
  assert.match(r.stderr, /SaaS\/Cloud トークン形式/);
});

test('非テストファイルの明白な PASSWORD 直書きは引き続き検出する', () => {
  const repo = mkRepo({ 'settings.py': kv(K.password, FAKE_PASSWORD_VALUE) + '\n' });
  const r = run(repo);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /PASSWORD\/API_TOKEN 等の変数代入/);
});

test('非テストファイルの本物らしい40文字以上の英数字は引き続き検出する', () => {
  const repo = mkRepo({ 'blob.txt': `payload = "${LONG_ALNUM}"\n` });
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
    const body = kv(K.password, FAKE_PASSWORD_VALUE) + '\n' + kv(K.token, FAKE_TOKEN_VALUE) + '\n';
    const repo = mkRepo({ [p]: body });
    const r = run(repo);
    assert.strictEqual(r.status, 0, `テストファイルのダミー値まで止めてはいけない\n${r.stderr}`);
  });

  test(`テスト/フィクスチャファイル(${p})の長い英数字は誤検出しない`, () => {
    const repo = mkRepo({ [p]: `const blob = "${LONG_ALNUM}";\n` });
    const r = run(repo);
    assert.strictEqual(r.status, 0, `テストファイルの長い英数字まで止めてはいけない\n${r.stderr}`);
  });
}

test('ファイル名に test を含むだけ（ディレクトリ/拡張子で区切られない）は誤って除外しない', () => {
  // "contest.py" は "test" を部分文字列に含むが、テストファイルではない。
  // 除外がここまで広がると本物の値を見逃す。
  const repo = mkRepo({ 'contest.py': kv(K.password, FAKE_PASSWORD_VALUE) + '\n' });
  const r = run(repo);
  assert.strictEqual(r.status, 1, '"contest.py" のようなファイルまでテスト扱いで除外してはいけない');
});

// ---------------------------------------------------------------------------
// 誤検出の修正: 大文字小文字違いのプレースホルダ表記
// ---------------------------------------------------------------------------

const CASE_VARIANT_PLACEHOLDERS = [
  kv(K.apiToken, 'Fake' + '1234567890ABCDEF'),
  kv(K.secret, 'REPLACE-WITH-' + 'your-own-value'),
  kv(K.password, 'PLACEHOLDER' + '12345678'),
  kv(K.apiKey, 'XXXXXXXX' + 'XXXXXXXXXXXX'),
  kv(K.token, 'REDACTED' + '1234567890AB'),
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
  const repo = mkRepo({ 'settings.py': kv(K.password + '_HASH', BCRYPT_SAMPLE) + '\n' });
  const r = run(repo);
  assert.strictEqual(r.status, 0, `ハッシュ化済みの値を秘密の値として止めてしまった\n${r.stderr}`);
});

test('変数名に hash を含む代入は誤検出しない', () => {
  // "TOKEN" は直後の " = " で検出対象になるが、行に "HASH" を含むので除外されるべき。
  // 末尾を素の TOKEN/PASSWORD にせず接尾辞を付けると検出そのものが起きなくなる
  // （キーワード直後に "=" 以外の文字が挟まるため）ので、"HASH" は前に置く。
  const repo = mkRepo({ 'settings.py': kv('LEGACY_HASH_' + K.token, FAKE_TOKEN_VALUE) + '\n' });
  const r = run(repo);
  assert.strictEqual(r.status, 0, `hash 由来の変数名を秘密の値として止めてしまった\n${r.stderr}`);
});

// ---------------------------------------------------------------------------
// 誤検出の修正が検出漏れ（バイパス）を生んでいないことの回帰
// ---------------------------------------------------------------------------

test('"hash" を含むだけで無関係な変数名（HASHICORP_TOKEN 等）は除外しない', () => {
  // hash 除外のギャップを無制限にすると、"HASHICORP" のような無関係な語でも
  // "hash と TOKEN が同じ行にある" というだけで本物の値まで除外してしまう
  // （セキュリティレビュー・コードレビューの両方が指摘）。ギャップを
  // アンダースコア1個までに絞ったことで、これは除外されず検出され続ける。
  const repo = mkRepo({ 'settings.py': kv('HASHICORP_' + K.token, FAKE_TOKEN_VALUE) + '\n' });
  const r = run(repo);
  assert.strictEqual(r.status, 1, '"HASHICORP_TOKEN" のような無関係な語のせいで本物の値を見逃してはいけない');
  assert.match(r.stderr, /PASSWORD\/API_TOKEN 等の変数代入/);
});

test('hashicorp のような hash を含むだけの語では長い英数字の除外が発動しない', () => {
  const repo = mkRepo({ 'blob.txt': `hashicorp_ref = "${LONG_ALNUM}"\n` });
  const r = run(repo);
  assert.strictEqual(r.status, 1, '"hashicorp" のような語のせいで本物らしい長い英数字を見逃してはいけない');
  assert.match(r.stderr, /40文字以上の長い英数字/);
});

test('本物のシークレット行の直前が偽のファイルヘッダに見えるレイアウトでも検出を維持する', () => {
  // コードレビューで実測したバイパス経路の回帰テスト（1段目）。
  // 追加された行の中身が "++ " から始まると、diff 上の見た目は
  // "+"（追加行マーカー）+ "++ 本文" = "+++ 本文" になり、テスト/フィクスチャ
  // 判定がこれを diff のファイルヘッダと誤認しうる。誤認すると、
  // それ以降の追加行（本物のシークレットを含む行）が丸ごとテスト扱いになって
  // パターン2・3の検出から漏れる。
  const trickLine = '++ b/fake.test.js';
  const body = trickLine + '\n' + kv(K.password, FAKE_PASSWORD_VALUE) + '\n';
  const repo = mkRepo({ 'app.js': body });
  const r = run(repo);
  assert.strictEqual(r.status, 1, '偽ヘッダに化ける行の直後にある本物のシークレット行を見逃してはいけない');
  assert.match(r.stderr, /PASSWORD\/API_TOKEN 等の変数代入/);
});

test('偽の削除行(--)と偽の追加行(++)の組み合わせでも検出を維持する', () => {
  // セキュリティレビューで実機再現されたバイパス経路の回帰テスト（2段目）。
  // 1段目の修正（直前行が "--- " のときだけ "+++ " を受理）だけでは、
  // 削除された行の中身が "-- " から始まり、直後の追加行の中身が "++ " から
  // 始まるケースを防げない。"-" + "-- 本文" = "--- 本文"、
  // "+" + "++ 本文" = "+++ 本文" が連続すると、偽の削除ヘッダ＋偽の追加ヘッダの
  // 組み合わせで「本物のヘッダの並び」をそのまま模倣できてしまう。
  // "diff --git " アンカー方式（プレフィックス文字が必ず付く追加/削除行とは
  // 構造的に衝突しない）に変えたことで、この組み合わせも防げることを確認する。
  const repo = mkRepo({ 'app.js': '-- old comment\n' });
  fs.writeFileSync(
    path.join(repo, 'app.js'),
    '++ b/fake.test.js\n' + kv(K.password, FAKE_PASSWORD_VALUE) + '\n',
  );
  execFileSync('git', ['add', '-A'], { cwd: repo, env: GIT_ENV });
  execFileSync(
    'git',
    ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'second'],
    { cwd: repo, env: GIT_ENV },
  );
  const r = run(repo);
  assert.strictEqual(r.status, 1, '偽の削除行と偽の追加行の組み合わせで本物のシークレット行を見逃してはいけない');
  assert.match(r.stderr, /PASSWORD\/API_TOKEN 等の変数代入/);
});

test('テスト/フィクスチャファイルを本番コードのパスへリネームしつつ追記したシークレットは検出を維持する', () => {
  // セキュリティレビューで実機再現されたバイパス経路の回帰テスト。
  // "diff --git a/<旧パス> b/<新パス>" というリネームの diff ヘッダから、
  // 判定に使う file を旧パス（a/ 側）のまま抽出してしまうと、テスト/フィクスチャの
  // パスから本番コードのパスへリネームしつつ末尾に本物のシークレットを追記する
  // 操作で、パターン2・3の検出を丸ごとすり抜けられる。新パス（b/ 側）を
  // 使うよう直したので、リネーム後の本番パスとして検出され続けることを確認する。
  const filler = Array.from({ length: 20 }, (_, i) => `line ${i}\n`).join('');
  const repo = mkRepo({ 'tests/foo.js': filler });
  fs.unlinkSync(path.join(repo, 'tests', 'foo.js'));
  const newPath = path.join(repo, 'src', 'foo.js');
  fs.mkdirSync(path.dirname(newPath), { recursive: true });
  fs.writeFileSync(newPath, filler + kv(K.password, FAKE_PASSWORD_VALUE) + '\n');
  execFileSync('git', ['add', '-A'], { cwd: repo, env: GIT_ENV });
  execFileSync(
    'git',
    ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'rename'],
    { cwd: repo, env: GIT_ENV },
  );
  // テストの前提: git がこの内容類似度でリネームとして検出していること
  const diffOut = execFileSync('git', ['log', '-p', '--max-count=1'], { cwd: repo, env: GIT_ENV, encoding: 'utf8' });
  assert.match(diffOut, /^diff --git a\/tests\/foo\.js b\/src\/foo\.js$/m, 'テストの前提: rename として検出されていない');
  const r = run(repo);
  assert.strictEqual(r.status, 1, 'リネームで本番パスへ移動しつつ追記したシークレットを見逃してはいけない');
  assert.match(r.stderr, /PASSWORD\/API_TOKEN 等の変数代入/);
});

test('非ASCIIファイル名のリネーム（git がパスをクォートする）でも検出を維持する', () => {
  // セキュリティレビューで実機再現されたバイパス経路の回帰テスト。
  // git は core.quotepath（既定 true）により、非ASCII文字を含むパスを
  // ダブルクォート＋8進エスケープで囲む
  // （例: diff --git "a/tests/\346\227\245..." "b/src/\346\227\245..."）。
  // この形は "diff --git a/.* b/" に一致しないため sub が空振りし、file には
  // 未加工の行全体（旧パスの "tests/" という断片を含む）が残ってしまう。
  // それをそのまま判定に使うと、新パスが本番コードでも旧パスの "tests/" に
  // 引っ張られて istest=true と誤判定されうる。パース失敗時は安全側
  // （走査する）に倒すよう直したので、検出され続けることを確認する。
  const filler = Array.from({ length: 20 }, (_, i) => `line ${i}\n`).join('');
  const oldName = '日本語.js';
  const repo = mkRepo({ [`tests/${oldName}`]: filler });
  fs.unlinkSync(path.join(repo, 'tests', oldName));
  const newPath = path.join(repo, 'src', oldName);
  fs.mkdirSync(path.dirname(newPath), { recursive: true });
  fs.writeFileSync(newPath, filler + kv(K.password, FAKE_PASSWORD_VALUE) + '\n');
  execFileSync('git', ['add', '-A'], { cwd: repo, env: GIT_ENV });
  execFileSync(
    'git',
    ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'rename'],
    { cwd: repo, env: GIT_ENV },
  );
  // テストの前提: git がこのパスをクォートしてリネームと検出していること
  const diffOut = execFileSync('git', ['log', '-p', '--max-count=1'], { cwd: repo, env: GIT_ENV, encoding: 'utf8' });
  assert.match(diffOut, /^diff --git "a\/tests\/.* "b\/src\/.*"$/m, 'テストの前提: クォート付きリネームとして検出されていない');
  const r = run(repo);
  assert.strictEqual(r.status, 1, '非ASCIIファイル名のリネームで本物のシークレットを見逃してはいけない');
  assert.match(r.stderr, /PASSWORD\/API_TOKEN 等の変数代入/);
});

test('旧パスに区切りを模した文字列(" b/tests/...")を仕込んだリネームでも検出を維持する', () => {
  // セキュリティレビューで実機再現された、パーステキスト方式そのものの限界を
  // 突いたバイパス経路の回帰テスト。
  //
  // 旧パス（a/ 側）自体が " b/tests/foo.js" という部分文字列を含み、かつ
  // 新パス（b/ 側）が非ASCII文字を含んでクォートされると、diff は
  // `diff --git a/evil b/tests/foo.js "b/src/新パス.js"` のような行になる。
  // "diff --git a/" の直後から最後の " b/" までを新パスとして切り出す方式
  // （パースに失敗したら安全側に倒すフォールバック込み）では、この行の中に
  // 実在する " b/"（旧パスの一部）に貪欲マッチが「成功」してしまい、
  // 抽出結果が「旧パスの断片＋新パスの残骸」という中途半端な文字列になる。
  // これは "^diff --git " では始まらないため、パース失敗の検知（safe
  // fallback）もすり抜け、旧パス側の "tests/" に引っ張られて誤って
  // istest=true になっていた。
  //
  // ファイルパスの抽出を diff 本文のテキストパースに一切頼らず、別途取得した
  // `git diff --name-only -z` の一覧と出現順で突き合わせる方式に直したので、
  // このクラスのバイパスは（ファイル名がどれだけ細工されていても）原理的に
  // 発生しない。
  const filler = Array.from({ length: 20 }, (_, i) => `line ${i}\n`).join('');
  const oldName = 'evil b/tests/foo.js';
  const repo = mkRepo({ [oldName]: filler });
  fs.unlinkSync(path.join(repo, oldName));
  const newName = 'src/新しい.js';
  const newPath = path.join(repo, newName);
  fs.mkdirSync(path.dirname(newPath), { recursive: true });
  fs.writeFileSync(newPath, filler + kv(K.apiToken, FAKE_TOKEN_VALUE) + '\n');
  execFileSync('git', ['add', '-A'], { cwd: repo, env: GIT_ENV });
  execFileSync(
    'git',
    ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'rename'],
    { cwd: repo, env: GIT_ENV },
  );
  // テストの前提: 旧パス（a/側）はクォートなし、新パス（b/側）はクォート付きで
  // リネームとして検出されていること（貪欲マッチの罠が成立する形）
  const diffOut = execFileSync('git', ['log', '-p', '--max-count=1'], { cwd: repo, env: GIT_ENV, encoding: 'utf8' });
  assert.match(diffOut, /^diff --git a\/evil b\/tests\/foo\.js "b\/src\/.*"$/m, 'テストの前提: 想定した形のリネームになっていない');
  const r = run(repo);
  assert.strictEqual(r.status, 1, '旧パスの区切り文字列に惑わされて本物のシークレットを見逃してはいけない');
  assert.match(r.stderr, /PASSWORD\/API_TOKEN 等の変数代入/);
});
