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

// upstream 設定済みのリポジトリを作る。secret-scan.sh は upstream があると
// `git diff/log -z --name-only "@{upstream}..HEAD"`（HEAD range とは別の
// コードパス）を通るため、mkRepo（HEAD range 固定）とは別に用意する。
// 実際の push 時にはこちらの経路が使われる。
function mkRepoWithUpstream(initialFiles) {
  const bare = tmpdir('bare');
  execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', bare], { env: GIT_ENV });
  const work = tmpdir('clone');
  execFileSync('git', ['clone', '-q', bare, work], { env: GIT_ENV });
  for (const [name, body] of Object.entries(initialFiles)) {
    const abs = path.join(work, name);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  execFileSync('git', ['add', '-A'], { cwd: work, env: GIT_ENV });
  execFileSync(
    'git',
    ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'init'],
    { cwd: work, env: GIT_ENV },
  );
  execFileSync('git', ['push', '-q', '-u', 'origin', 'main'], { cwd: work, env: GIT_ENV });
  return work;
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

test('非テストファイルの40文字以上の英数字は表示するが止めない（情報のみ）', () => {
  // 実測: 全履歴で止まった誤検出の主因。既知の形式は他のパターンが形で見るので止めない。
  const repo = mkRepo({ 'blob.txt': `payload = "${LONG_ALNUM}"\n` });
  const r = run(repo);
  assert.strictEqual(r.status, 0, `長い英数字だけでは止めない\n${r.stderr}`);
  assert.match(r.stderr, /40文字以上の長い英数字が 1 件（止めません/);
});

// ---------------------------------------------------------------------------
// 誤検出の修正: package-lock.json の sha512 integrity ハッシュ（ユーザー報告）
// ---------------------------------------------------------------------------
// 報告された誤検出: package-lock.json の "integrity" キーと値が別の行に分かれると
// （フォーマッタ・手動整形等で発生しうる）、"integrity" という語が値の行に無くなり、
// 値そのもの（sha512-<base64>）が「40文字以上の長い英数字」として検出されていた。
// 既存の "integrity" 除外はキーと値が同じ行にあることに依存していたため、値の形
// （sha512- 接頭辞）そのものを見るよう直した。

test('SRI形式（sha512-<base64>）のハッシュ値は、キーが同じ行に無くても誤検出しない', () => {
  const repo = mkRepo({
    'package-lock.json': [
      '{',
      '  "packages": {',
      '    "node_modules/foo": {',
      '      "integrity":',
      `        "sha512-${'a1B2c3D4'.repeat(11)}=="`,
      '    }',
      '  }',
      '}',
      '',
    ].join('\n'),
  });
  const r = run(repo);
  assert.strictEqual(r.status, 0, `SRI 形式のハッシュ値を誤検出した\n${r.stderr}`);
});

test('キーと同じ行にある通常の integrity 行（実際の npm 出力形）も誤検出しない（回帰）', () => {
  const repo = mkRepo({
    'package-lock.json':
      `      "integrity": "sha512-${'a1B2c3D4'.repeat(11)}==",\n`,
  });
  const r = run(repo);
  assert.strictEqual(r.status, 0, `通常形の integrity 行を誤検出した\n${r.stderr}`);
});

test('sha512- を前置しても、既知トークン prefix や変数代入としての検出はすり抜けない', () => {
  // パターン3の sha512- 除外は「値の形」だけを見る。本物のトークンや
  // PASSWORD/TOKEN への代入として書かれた値は、sha512- を前に付けても
  // パターン1・パターン2でそれぞれ引き続き検出されることを固定する。
  const repoToken = mkRepo({ 'conf.py': `${K.token} = "sha512-ghp_${'A'.repeat(36)}"\n` });
  const rToken = run(repoToken);
  assert.strictEqual(rToken.status, 1, 'sha512- を前置した本物のトークンを見逃した');
  assert.match(rToken.stderr, /SaaS\/Cloud トークン形式/);

  const repoPassword = mkRepo({
    'settings.py': kv(K.password, 'sha512-' + FAKE_PASSWORD_VALUE) + '\n',
  });
  const rPassword = run(repoPassword);
  assert.strictEqual(rPassword.status, 1, 'sha512- を前置した PASSWORD 代入を見逃した');
  assert.match(rPassword.stderr, /PASSWORD\/API_TOKEN 等の変数代入/);
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

test('hashicorp のような hash を含むだけの語では長い英数字の除外が発動しない（情報表示に出る）', () => {
  // 止めないパターンになったので、除外が効いているかどうかは「情報表示に出るか」で見る。
  const repo = mkRepo({ 'blob.txt': `hashicorp_ref = "${LONG_ALNUM}"\n` });
  const r = run(repo);
  assert.strictEqual(r.status, 0);
  assert.match(r.stderr, /40文字以上の長い英数字が 1 件/, '"hashicorp" のせいで除外されてはいけない');
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

test('ファイル名に埋め込まれた改行があっても後続ファイルの対応がずれない', () => {
  // セキュリティレビューで実機再現されたバイパス経路の回帰テスト。
  // $FILES_LIST は `git diff/log -z --name-only`（NUL区切り）から作るが、
  // 単純に NUL→改行 の tr 変換をすると、ファイル名自体に埋め込まれた改行
  // （POSIX 上は許可されている）がその場でレコード境界になってしまい、
  // 1つのファイルが2行に割れて以降すべてのファイルの対応が1つずつずれる。
  // ここでは「innocent.txt\ntests/evil」という1つのファイル名が
  // 「innocent.txt」「tests/evil」の2行に割れ、次に来る本物の本番ファイル
  // （src/prod.js）の判定に「tests/evil」という行が使われてしまうことで、
  // 本物のシークレットがテストファイル扱いになって検出をすり抜けていた。
  // NUL区切りのまま扱う（改行はエスケープしてから1行化する）よう直したので、
  // 対応がずれず検出され続けることを確認する。
  const trickName = 'innocent.txt\ntests/evil';
  const repo = mkRepo({
    [trickName]: 'harmless\n',
    'src/prod.js': 'harmless\n' + kv(K.password, FAKE_PASSWORD_VALUE) + '\n',
  });
  // テストの前提: name-only の順序で trickName が prod.js より先に来ること
  const nameOnly = execFileSync('git', ['log', '-z', '--name-only', '--format=', '--max-count=1'], {
    cwd: repo,
    env: GIT_ENV,
    encoding: 'utf8',
  });
  const names = nameOnly.split('\0').filter(Boolean);
  assert.deepStrictEqual(names, [trickName, 'src/prod.js'], 'テストの前提: name-only の並び順が想定と異なる');
  const r = run(repo);
  assert.strictEqual(r.status, 1, 'ファイル名の埋め込み改行でファイル対応がずれ、本番ファイルの秘密を見逃してはいけない');
  assert.match(r.stderr, /PASSWORD\/API_TOKEN 等の変数代入/);
});

// ---------------------------------------------------------------------------
// 誤検出の修正が検出漏れ（バイパス）を生んでいないことの回帰（除外語のdecoy）
// ---------------------------------------------------------------------------

test('除外語が値と無関係な場所（末尾コメント等）にあるだけでは除外しない', () => {
  // 敵対的レビューで実機再現されたバイパス経路の回帰テスト。
  // 除外語の判定を行全体に対して行うと、値とは無関係な場所（末尾コメント等）
  // に除外語を1つ混ぜるだけで、本物らしい値まで検出をすり抜けられる。
  // 判定は「代入された値そのもの」に対してだけ行うよう直したので、
  // 値の外にある decoy には影響されず検出され続けることを確認する。
  const realishValue = 'aB3xQ9mK' + '2pL7vN4rT8s';
  const line = kv(K.password, realishValue) + '  # this is not a sample value';
  const repo = mkRepo({ 'settings.py': line + '\n' });
  const r = run(repo);
  assert.strictEqual(r.status, 1, '値と無関係な場所の除外語のせいで本物らしい値を見逃してはいけない');
  assert.match(r.stderr, /PASSWORD\/API_TOKEN 等の変数代入/);
});

test('除外語が値の中に部分文字列として埋め込まれているだけでは除外しない', () => {
  // 敵対的レビューで実機再現されたバイパス経路の回帰テスト。
  // 値だけを取り出しても、除外語が値の一部にたまたま（または意図的に）
  // 埋め込まれているケースは残る（例: "notFakeRealSecretXYZ9" は値を
  // 切り出しても "fake" を含む）。プレースホルダを示す英単語は前後が
  // 英字で挟まれていない位置でのみ一致させるようにしたので、値の途中に
  // 埋め込まれた decoy には影響されず検出され続けることを確認する。
  const decoyInValue = 'notFake' + 'RealSecretXYZ9';
  const repo = mkRepo({ 'conf.py': kv(K.apiToken, decoyInValue) + '\n' });
  const r = run(repo);
  assert.strictEqual(r.status, 1, '値に埋め込まれた除外語のせいで本物らしい値を見逃してはいけない');
  assert.match(r.stderr, /PASSWORD\/API_TOKEN 等の変数代入/);
});

// ---------------------------------------------------------------------------
// upstream 設定済み（実際の push 経路）でも同じ判定になることの回帰
// ---------------------------------------------------------------------------
// ここまでの全テストは upstream が無いリポジトリ（HEAD range = `git log -p`）
// だけを対象にしていた。しかし実際の push 時に使われるのは upstream がある
// 場合の `git diff/log -z --name-only "@{upstream}..HEAD"` という別の
// コードパスで、敵対的検証でこちらのテストが1件も無いことを指摘された
// （2つの経路は同じ awk/grep ロジックを共有するが、diff の取得コマンド自体は
// 別物であり、片方だけ壊れても自動検知できない）。代表的な回帰を1件、
// この経路でも確認する。

test('upstream 設定済み（実際の push 経路）でもリネームで本番パスへ移動した秘密を見逃さない', () => {
  const filler = Array.from({ length: 20 }, (_, i) => `line ${i}\n`).join('');
  const work = mkRepoWithUpstream({ 'tests/foo.js': filler });
  fs.unlinkSync(path.join(work, 'tests', 'foo.js'));
  const newPath = path.join(work, 'src', 'foo.js');
  fs.mkdirSync(path.dirname(newPath), { recursive: true });
  fs.writeFileSync(newPath, filler + kv(K.password, FAKE_PASSWORD_VALUE) + '\n');
  execFileSync('git', ['add', '-A'], { cwd: work, env: GIT_ENV });
  execFileSync(
    'git',
    ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'rename'],
    { cwd: work, env: GIT_ENV },
  );
  // テストの前提: upstream 経由で @{upstream}..HEAD が解決すること（未 push の1コミット分）
  const upstreamRange = execFileSync('git', ['rev-parse', '@{upstream}'], { cwd: work, env: GIT_ENV, encoding: 'utf8' });
  assert.ok(upstreamRange.trim().length > 0, 'テストの前提: upstream が解決できない');
  const r = run(work);
  assert.strictEqual(r.status, 1, 'upstream 経路でもリネームで本番パスへ移動した秘密を見逃してはいけない');
  assert.match(r.stderr, /PASSWORD\/API_TOKEN 等の変数代入/);
});

test('upstream 設定済み（実際の push 経路）では push 済みのコミットまで走査しない', () => {
  // 回帰の副作用チェック: @{upstream}..HEAD の範囲指定そのものが壊れていないこと。
  const work = mkRepoWithUpstream({ 'a.md': 'init\n' });
  const r = run(work);
  assert.strictEqual(r.status, 0, 'push 済みのコミットまで走査してはいけない');
  assert.match(r.stderr, /スキャン対象の差分なし/);
});

// ---------------------------------------------------------------------------
// 見逃しの修正（実測: 本物らしい値 18 ケース中 8 件を見逃していた）
// ---------------------------------------------------------------------------
// 値は連結で組み立てる（冒頭の理由）。VAL は数字を含む 24 文字（ランダム風）。

const VAL = 'aB3xQ9mK2pL7vN4r' + 'T8sZ1cD5';
const B64U = 'aB3xQ9mK2pL7vN4rT8sZ1cD5eF6gH7iJ8kL9mN0o';

function scan(file, body) {
  return run(mkRepo({ [file]: body }));
}

function assertBlocked(r, label, re) {
  assert.strictEqual(r.status, 1, `${label} を見逃した\n${r.stderr}`);
  if (re) assert.match(r.stderr, re);
}

function assertPassed(r, label) {
  assert.strictEqual(r.status, 0, `${label} を誤検出した\n${r.stderr}`);
}

// --- 変数代入: 大文字小文字・キーの閉じクォート・SECRET_KEY 系 ---

for (const [label, body] of [
  ['小文字 password（Python）', `password = "${VAL}"`],
  ['先頭だけ大文字 Password', `Password = "${VAL}"`],
  ['小文字 api_key', `api_key = "${VAL}"`],
  ['camelCase apiKey（JS）', `const apiKey = "${VAL}";`],
  ['camelCase accessToken', `const accessToken = '${VAL}';`],
  ['小文字 client_secret（YAML）', `client_secret: "${VAL}"`],
  ['JSON のキーが引用符で囲まれた api_key', `{ "api_key": "${VAL}" }`],
  ['JSON のキーが引用符で囲まれた大文字 API_TOKEN', `{ "API_` + `TOKEN": "${VAL}" }`],
  ['Django の SECRET_KEY', `SECRET_` + `KEY = '${VAL}'`],
  ['AWS の SECRET_ACCESS_KEY（引用符なし）', `AWS_SECRET_` + `ACCESS_KEY=${VAL}`],
]) {
  test(`変数代入を検出する: ${label}`, () => {
    assertBlocked(scan('src/app.conf', body + '\n'), label, /PASSWORD\/API_TOKEN 等の変数代入/);
  });
}

// 大文字小文字を区別しない側は誤検出を避けるため絞っている。絞りが外れていないこと。
for (const [label, body] of [
  ['識別子同士の代入', 'token = get_token(request)'],
  ['関数呼び出し結果の代入', 'password = hash_password(raw_input_value)'],
  ['別の変数への代入（数字なし）', 'password: passwordInputValue'],
  ['型注釈', 'password: string;'],
  ['ラベル文字列（数字なし）', `{ "type": "refresh_token" }`],
  ['引用符なしの小文字（数字を含んでも識別子）', 'token = tokenizer2_instance'],
  ['プレースホルダ（your-）', `api_key = "your-api-key-1234"`],
  ['プレースホルダ（changeme）', `password = "changeme123"`],
  ['環境変数参照', `api_key = "\${{ secrets.API_KEY_1 }}"`],
  ['ハッシュ化済みの値', `password_hash = "${BCRYPT_SAMPLE}"`],
]) {
  test(`小文字側の誤検出を避ける: ${label}`, () => {
    assertPassed(scan('src/app.py', body + '\n'), label);
  });
}

test('小文字側もテスト/フィクスチャでは対象外', () => {
  assertPassed(scan('tests/conf.py', `password = "${VAL}"\n`), 'テストファイルの小文字 password');
});

test('小文字側の限界: 数字を含まない英字だけの値は見逃す（誤検出との引き換えとして固定）', () => {
  // この限界を黙って変えないためのテスト。変える場合は SKILL.md の記述も直す。
  assertPassed(scan('src/app.py', 'password = "abcdefghijklmnopqrst"\n'), '数字なしの値');
});

// --- 既知トークン形式 ---

for (const [label, body] of [
  ['Anthropic sk-ant-', `k = "sk-ant-api03-${B64U}-_${B64U}"`],
  ['OpenAI sk-proj-', `k = "sk-proj-${B64U}_${B64U}"`],
  ['Stripe 本番キー', `k = "sk_` + `live_${B64U.replace(/[-_]/g, '').slice(0, 24)}"`],
  ['Slack webhook', `u = "https://hooks.` + `slack.com/services/T0AB12CD3/B0EF45GH6/${B64U.slice(0, 24)}"`],
  ['PKCS#8 秘密鍵', '-----BEGIN ' + 'PRIVATE KEY-----'],
  ['暗号化 PKCS#8 秘密鍵', '-----BEGIN ENCRYPTED ' + 'PRIVATE KEY-----'],
  ['PGP 秘密鍵', '-----BEGIN PGP ' + 'PRIVATE KEY BLOCK-----'],
  ['npm トークン', `//registry.npmjs.org/:_authToken=npm_${B64U.replace(/[-_]/g, '').slice(0, 36)}`],
]) {
  test(`既知のトークン形式を検出する: ${label}`, () => {
    assertBlocked(scan('src/app.txt', body + '\n'), label, /SaaS\/Cloud トークン形式/);
  });
}

test('既知のトークン形式はテストファイルでも検出する（Anthropic）', () => {
  assertBlocked(scan('tests/k.py', `k = "sk-ant-api03-${B64U}"\n`), 'テストファイル内の sk-ant-', /SaaS\/Cloud/);
});

test('語の途中の sk- には反応しない（task- / disk-）', () => {
  assertPassed(scan('src/app.txt', `x = "task-ant-${B64U.slice(0, 30)}"\n`), 'task-ant-');
  assertPassed(scan('src/app.txt', `x = "disk-proj-${B64U.slice(0, 30)}"\n`), 'disk-proj-');
});

test('Stripe のテスト用キーは対象外（公開ドキュメントの例が多い）', () => {
  assertPassed(scan('src/app.txt', `k = "sk_` + `test_${B64U.replace(/[-_]/g, '').slice(0, 24)}"\n`), 'sk_test_');
});

// --- 認証情報つき URL / Bearer / JWT ---

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJ' + 'zdWIiOiIxMjM0NTY3ODkwIn0.' + B64U.slice(0, 30);

for (const [label, body] of [
  ['パスワード入りの DB 接続文字列', `DATABASE_URL=postgres://admin:${VAL}@db.internal:5432/app`],
  ['パスワード入りの https URL', `u = "https://deploy:${VAL}@git.internal/repo.git"`],
  ['Bearer ヘッダ', `headers = {'Authorization': 'Bearer ${B64U.slice(0, 30)}'}`],
  ['JWT', `t = "${JWT}"`],
]) {
  test(`認証情報つきの形を検出する: ${label}`, () => {
    assertBlocked(scan('src/app.py', body + '\n'), label, /認証情報つき URL \/ Bearer ヘッダ \/ JWT/);
  });
}

for (const [label, body] of [
  ['パスワードが password そのもの', 'DATABASE_URL=postgres://admin:password@localhost:5432/app'],
  ['パスワードが環境変数展開', 'DATABASE_URL=postgres://admin:${DB_PASSWORD}@db:5432/app'],
  ['パスワードがテンプレート', 'DATABASE_URL=postgres://admin:{{ db_password }}@db:5432/app'],
  ['パスワードがプレースホルダ角括弧', 'DATABASE_URL=postgres://admin:<password>@db:5432/app'],
  ['パスワードなしの URL', 'u = "https://example.com:8443/path"'],
  ['Bearer の後が変数展開', 'curl -H "Authorization: Bearer ${API_TOKEN_VALUE}" https://x'],
  ['Bearer の後が短い語', 'Authorization: Bearer <token>'],
]) {
  test(`認証情報つきの形の誤検出を避ける: ${label}`, () => {
    assertPassed(scan('src/app.sh', body + '\n'), label);
  });
}

test('認証情報つきの形はテストファイルでは対象外', () => {
  assertPassed(scan('tests/db.test.js', `const u = "postgres://admin:${VAL}@db/app";\n`), 'テスト内の接続文字列');
});

// --- 40文字以上の英数字は止めない ---

test('検出が別にあるときは、長い英数字は「参考」として添えるだけで理由にしない', () => {
  const repo = mkRepo({
    'a.py': `${K.password} = "${FAKE_PASSWORD_VALUE}"\n`,
    'b.txt': `payload = "${LONG_ALNUM}"\n`,
  });
  const r = run(repo);
  assertBlocked(r, '併存する本物の検出', /PASSWORD\/API_TOKEN 等の変数代入/);
  assert.match(r.stderr, /（参考）40文字以上の長い英数字 1 件。これは止める理由にしていません/);
});

test('Google ドライブのファイル ID（44文字）だけでは止まらない（実測の誤検出）', () => {
  assertPassed(scan('docs/note.md', 'fileId = "1dM1l1TUYPFCuce1UAqm4xS7OtMyXk4NQdb2Yuaupyg"\n'), 'ドライブの ID');
});

test('your- で始まるプレースホルダは、英字が続いても除外する（大文字側）', () => {
  assertPassed(scan('src/app.py', `${K.apiToken} = "your-api-key-1234"\n`), 'your-api-key-1234');
});

test('your- の除外は語の途中では発動しない（notyour-...）', () => {
  assertBlocked(scan('src/app.py', `${K.apiToken} = "notyour-realSecretXYZ9"\n`), 'notyour-...', /変数代入/);
});

test('URL のパスワード部は6文字以上だけを見る（短い値との区別を固定）', () => {
  assertPassed(scan('src/app.sh', 'u=ssh://git:ab12@host.internal/repo\n'), '4文字のパスワード部');
  assertBlocked(scan('src/app.sh', 'u=ssh://git:ab12cd@host.internal/repo\n'), '6文字のパスワード部', /認証情報つき URL/);
});

test('... で省略された値（ドキュメント中の例）は実値ではないので除外する', () => {
  assertPassed(scan('docs/usage.md', `{ "api_key": "sk-abc...xyz0" }\n`), '省略記法の例');
  assertPassed(scan('docs/usage.md', `${K.apiToken} = "abcd1234...wxyz"\n`), '省略記法の例（大文字側）');
});
