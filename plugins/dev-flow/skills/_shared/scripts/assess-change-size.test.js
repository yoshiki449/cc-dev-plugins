#!/usr/bin/env node
'use strict';

// assess-change-size.sh のテスト。
// 実行: node --test plugins/dev-flow/skills/_shared/scripts/assess-change-size.test.js
//
// 判定仕様の正は assess-change-size.sh 本体とこのテスト。conf の記法は
// skills/_shared/reference/size-tier-conf.md にある。設計の経緯は Issue #34
// （.agent/issue-34/phase1-contract.md は plugin 非同梱で配布先には届かない）。
// AC11〜AC26 は敵対的検証4レンズ（.agent/adversarial-review-34-phase1-{A,B,C,D,統合}.md）が
// 実測で見つけた穴の再現手順から逆生成している。各指摘はほぼ「判定が軽い方（S/LOW）に倒れ、
// fallback:false / warnings:[] の一見正常な JSON を出す」型に収束しているため、
// 単に size/risk を見るだけでなく「本来重い判定になるはずの入力が本当に重く出るか」を assert する。
//
// base/head は基本的に明示コミットハッシュで渡す（--base/--head）。
// merge-base 自動検出（main/master ブランチ探索）はテストごとの fixture 構築を複雑にし、
// 「サイズ/リスク判定ロジックの検証」と「ref 解決ロジックの検証」が混ざって
// 失敗原因の切り分けを難しくする。ref 解決だけを狙うのは AC4b（未解決）と
// AC9（base==head）に限定し、それ以外は明示 ref で決定的にする。

const test = require('node:test');
const assert = require('node:assert');
const { spawnSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
// 節の切り出しは skill-md-gate-tables.test.js / e2e-test-generator.test.js と共有する
// （AC47/AC50 が読む reference/size-tier-conf.md の「## キー一覧」節切り出しに使う）。
const { section } = require('./md-section.js');

const SCRIPT = path.join(__dirname, 'assess-change-size.sh');

// 実行環境（開発者の ~/.gitconfig 等）から隔離する。
// これが無いと commit.gpgsign や user.name が環境依存になり、CI や別マシンで再現しない。
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

// --dir を常に明示するので、spawn 時の cwd はどの git repo にも属さない中立な場所でよい。
const NEUTRAL_CWD = os.tmpdir();

function git(dir, args) {
  return execFileSync('git', args, { cwd: dir, env: GIT_ENV, encoding: 'utf8' });
}

function makeFixtureDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assess-size-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function initRepo(t, { branch } = {}) {
  const dir = makeFixtureDir(t);
  git(dir, ['init', '-q']);
  if (branch) {
    // 既定ブランチ名（main/master いずれか、git バージョン・設定依存）に頼らず
    // 明示的にブランチ名を固定する。AC4b は main/master が「存在しない」ことが前提。
    git(dir, ['checkout', '-q', '-b', branch]);
  }
  git(dir, ['config', 'user.name', 'Test User']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  return dir;
}

// n 行ちょうどのテキストを返す。末尾にも改行を入れて「最後の行が未終端で
// diff の解釈がずれる」事故を避ける（各行 \n 終端 = git diff --numstat が n を報告する）。
function nLines(n, prefix = 'line') {
  return Array.from({ length: n }, (_, i) => `${prefix} ${i}`).join('\n') + '\n';
}

function writeText(dir, relPath, content) {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function writeLines(dir, relPath, n) {
  writeText(dir, relPath, nLines(n));
}

// NUL バイトを含むバイナリファイル。git の binary 判定（先頭付近に NUL があるか）を
// 素直に満たすため Buffer.alloc の既定値（全 0 埋め）をそのまま使う。
function writeBinary(dir, relPath, size = 64) {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, Buffer.alloc(size));
}

function commit(dir, message) {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']).trim();
}

// base コミット（README のみ）を作った repo を返す。
function newBaseRepo(t) {
  const dir = initRepo(t, { branch: 'main' });
  writeLines(dir, 'README.md', 3);
  const base = commit(dir, 'base');
  return { dir, base };
}

function runScript(args) {
  return spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: GIT_ENV,
    cwd: NEUTRAL_CWD,
  });
}

function parseJsonOutput(res) {
  assert.equal(res.status, 0, `exit 0 を期待したが ${res.status}。stderr: ${res.stderr}`);
  const lines = res.stdout.trim().split('\n');
  assert.equal(lines.length, 1, `stdout は JSON 1行のみを期待: ${JSON.stringify(res.stdout)}`);
  return JSON.parse(lines[0]);
}

const SCHEMA_TOP_KEYS = [
  'size',
  'risk',
  'lines',
  'files',
  'matched_risk_paths',
  'excluded_paths',
  'scopes',
  'fallback',
  'fallback_reason',
  'warnings',
  'main_model',
  'verification_profile',
  'gates',
];
const SCHEMA_GATES_KEYS = [
  'adversarial_lenses',
  'code_reviewer',
  'self_review_members',
  'security_review',
  'test_ledger',
  'explain_diff',
  'qa',
];

const SELF_REVIEW_S = [
  'dev-flow:convention-reviewer',
  'dev-flow:requirement-coverage-checker',
  'dev-flow:Code-Reviewer',
];
const SELF_REVIEW_ML = [
  ...SELF_REVIEW_S,
  'dev-flow:simplify-reviewer',
  'dev-flow:codex-cross-reviewer',
];

// --- スキーマ整合性（§2: キーの増減・改名は不可）---------------------------

test('出力 JSON のトップレベル/gates キーはスキーマ通り（増減・改名なし）', (t) => {
  const { dir, base } = newBaseRepo(t);
  writeLines(dir, 'src/util/a.ts', 10);
  const head = commit(dir, 'change');

  const out = parseJsonOutput(runScript(['--dir', dir, '--base', base, '--head', head]));

  assert.deepEqual(Object.keys(out), SCHEMA_TOP_KEYS);
  assert.deepEqual(Object.keys(out.gates), SCHEMA_GATES_KEYS);
});

// --- AC1 + AC3: S/M/L × LOW/HIGH の6通り。gates は deep equal で丸ごと検証 ---
// S,HIGH は「リスクHIGHのファイル1つを含む50行diff」という形で AC3 の条件も兼ねる。

test('AC1/AC3: S × LOW（40行・非リスクパス）', (t) => {
  const { dir, base } = newBaseRepo(t);
  writeLines(dir, 'src/util/a.ts', 40);
  const head = commit(dir, 'change');

  const out = parseJsonOutput(runScript(['--dir', dir, '--base', base, '--head', head]));

  assert.equal(out.size, 'S');
  assert.equal(out.risk, 'LOW');
  assert.deepEqual(out.gates, {
    adversarial_lenses: ['A'],
    code_reviewer: 'ship',
    self_review_members: SELF_REVIEW_S,
    security_review: false,
    test_ledger: 'skip',
    explain_diff: 'post_pr',
    qa: 'optional',
  });
});

test('AC1/AC3: S × HIGH（50行・単一のリスクパス src/api/users.ts）', (t) => {
  const { dir, base } = newBaseRepo(t);
  writeLines(dir, 'src/api/users.ts', 50);
  const head = commit(dir, 'change');

  const out = parseJsonOutput(runScript(['--dir', dir, '--base', base, '--head', head]));

  assert.equal(out.size, 'S');
  assert.equal(out.risk, 'HIGH');
  assert.deepEqual(out.matched_risk_paths, ['src/api/users.ts']);
  assert.deepEqual(out.gates, {
    adversarial_lenses: ['A', 'D'],
    code_reviewer: 'ship',
    self_review_members: SELF_REVIEW_S,
    security_review: true,
    test_ledger: 'skip',
    explain_diff: 'post_pr',
    // src/api/users.ts は backend スコープにも当たるが、frontend の陽性証拠が無いので
    // 両スコープにならず optional（契約 §5.5「分類不能を両方に数えない」の帰結）。
    qa: 'optional',
  });
});

test('AC1: M × LOW（200行・非リスクパス）', (t) => {
  const { dir, base } = newBaseRepo(t);
  writeLines(dir, 'src/util/b.ts', 200);
  const head = commit(dir, 'change');

  const out = parseJsonOutput(runScript(['--dir', dir, '--base', base, '--head', head]));

  assert.equal(out.size, 'M');
  assert.equal(out.risk, 'LOW');
  assert.deepEqual(out.gates, {
    adversarial_lenses: ['A', 'B'],
    code_reviewer: 'ship',
    self_review_members: SELF_REVIEW_ML,
    security_review: false,
    test_ledger: 'post_pr',
    explain_diff: 'post_pr',
    qa: 'optional',
  });
});

test('AC1: M × HIGH（200行・リスクパス src/api/orders.ts）', (t) => {
  const { dir, base } = newBaseRepo(t);
  writeLines(dir, 'src/api/orders.ts', 200);
  const head = commit(dir, 'change');

  const out = parseJsonOutput(runScript(['--dir', dir, '--base', base, '--head', head]));

  assert.equal(out.size, 'M');
  assert.equal(out.risk, 'HIGH');
  assert.deepEqual(out.gates, {
    adversarial_lenses: ['A', 'B', 'D'],
    code_reviewer: 'ship',
    self_review_members: SELF_REVIEW_ML,
    security_review: true,
    test_ledger: 'post_pr',
    explain_diff: 'post_pr',
    qa: 'optional',
  });
});

test('AC1: L × LOW（600行・非リスクパス）', (t) => {
  const { dir, base } = newBaseRepo(t);
  writeLines(dir, 'src/util/c.ts', 600);
  const head = commit(dir, 'change');

  const out = parseJsonOutput(runScript(['--dir', dir, '--base', base, '--head', head]));

  assert.equal(out.size, 'L');
  assert.equal(out.risk, 'LOW');
  assert.deepEqual(out.gates, {
    adversarial_lenses: ['A', 'B', 'C'],
    code_reviewer: 'per_phase',
    self_review_members: SELF_REVIEW_ML,
    security_review: false,
    test_ledger: 'pre_pr',
    explain_diff: 'post_pr',
    qa: 'optional',
  });
});

test('AC1: L × HIGH（600行・リスクパス src/api/payments.ts）', (t) => {
  const { dir, base } = newBaseRepo(t);
  writeLines(dir, 'src/api/payments.ts', 600);
  const head = commit(dir, 'change');

  const out = parseJsonOutput(runScript(['--dir', dir, '--base', base, '--head', head]));

  assert.equal(out.size, 'L');
  assert.equal(out.risk, 'HIGH');
  assert.deepEqual(out.gates, {
    adversarial_lenses: ['A', 'B', 'C', 'D'],
    code_reviewer: 'per_phase',
    self_review_members: SELF_REVIEW_ML,
    security_review: true,
    test_ledger: 'pre_pr',
    explain_diff: 'post_pr',
    qa: 'optional',
  });
});

// --- AC1b: サイズ境界（99=S, 100=M, 500=M, 501=L）---------------------------

test('AC1b: サイズ境界値（99/100/500/501行）', (t) => {
  const cases = [
    [99, 'S'],
    [100, 'M'],
    [500, 'M'],
    [501, 'L'],
  ];

  for (const [lineCount, expectedSize] of cases) {
    const { dir, base } = newBaseRepo(t);
    writeLines(dir, 'src/util/boundary.ts', lineCount);
    const head = commit(dir, 'change');

    const out = parseJsonOutput(runScript(['--dir', dir, '--base', base, '--head', head]));

    assert.equal(out.size, expectedSize, `${lineCount}行は${expectedSize}を期待`);
    assert.equal(out.lines, lineCount);
  }
});

// --- AC4: 非git ディレクトリのフォールバック --------------------------------

test('AC4: git リポジトリではないディレクトリは fallback:true/L/HIGH を stdout に出し exit 0', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assess-size-notgit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const res = runScript(['--dir', dir]);
  const out = parseJsonOutput(res);

  assert.equal(out.fallback, true);
  assert.equal(out.size, 'L');
  assert.equal(out.risk, 'HIGH');
  assert.notEqual(out.fallback_reason, '');
  assert.equal(out.lines, 0);
  assert.equal(out.files, 0);
  assert.deepEqual(out.matched_risk_paths, []);
  assert.deepEqual(out.excluded_paths, []);
});

// --- AC4b: base ref を解決できない repo のフォールバック --------------------

test('AC4b: main/master も origin も無い repo は --base 未指定でフォールバック', (t) => {
  // main/master という名前のブランチを一切作らない（自動検出の4候補すべてを外す）。
  const dir = initRepo(t, { branch: 'work' });
  writeLines(dir, 'README.md', 3);
  commit(dir, 'init');

  const out = parseJsonOutput(runScript(['--dir', dir]));

  assert.equal(out.fallback, true);
  assert.equal(out.size, 'L');
  assert.equal(out.risk, 'HIGH');
  assert.notEqual(out.fallback_reason, '');
});

// --- AC5: lockfile はサイズから除外・ただしリスクには除外を適用しない -------

test('AC5: 除外パスはサイズから外れるがリスク照合には全パスが使われる', (t) => {
  const { dir, base } = newBaseRepo(t);
  // 3ファイル、頭文字が p < s < v の順なので diff の出現順もこの順になる想定
  writeLines(dir, 'package-lock.json', 500); // 既定で除外・リスクには非該当
  writeLines(dir, 'src/util/plain.js', 30); // 除外もリスクも非該当（サイズに効く唯一のファイル）
  writeLines(dir, 'vendor/api/client.js', 20); // 既定で除外（**/vendor/**）だがリスクにも一致（**/api/**）
  const head = commit(dir, 'change');

  const out = parseJsonOutput(runScript(['--dir', dir, '--base', base, '--head', head]));

  assert.equal(out.lines, 30, '除外ファイルの行数がサイズ集計に混ざっている');
  assert.equal(out.files, 3);
  assert.equal(out.size, 'S');
  assert.equal(out.risk, 'HIGH', '除外パスでもリスク照合には効くはず');
  assert.deepEqual(out.matched_risk_paths, ['vendor/api/client.js']);
  assert.deepEqual(out.excluded_paths, ['package-lock.json', 'vendor/api/client.js']);
});

// --- AC6: binary ファイルは0行・filesには含まれる ---------------------------

test('AC6: binary ファイルは0行として数えられるが files には含まれる', (t) => {
  const { dir, base } = newBaseRepo(t);
  writeBinary(dir, 'assets/logo.png', 64);
  writeLines(dir, 'src/text.js', 40);
  const head = commit(dir, 'change');

  const out = parseJsonOutput(runScript(['--dir', dir, '--base', base, '--head', head]));

  assert.equal(out.lines, 40, 'binary ファイルの行数が0扱いになっていない');
  assert.equal(out.files, 2);
  assert.equal(out.size, 'S');
});

// --- AC7: .agent/size-tier.conf の上書き・追加・reset・不正行 ---------------

test('AC7: threshold_m/l 上書き・risk: 追加・不正行の warnings 記録', (t) => {
  const { dir, base } = newBaseRepo(t);
  // threshold_m/l の引き下げと risk: 追加は §3.1 改訂でいう「厳格化」方向なので、
  // それだけでは conf 変更 warning は出ない（AC10 参照）。順序の決定性を固定するテストの
  // 意図を保つため、緩和方向の exclude: を1行足して2件目の warning を意図的に出させる。
  writeText(
    dir,
    '.agent/size-tier.conf',
    [
      'threshold_m=50',
      'threshold_l=200',
      'risk: src/payments/**',
      'bogus_line_here', // 4行目。解釈できない行として warning に「行番号だけ」が出るはず
      'exclude: **/generated/**',
      '',
    ].join('\n'),
  );
  writeLines(dir, 'src/payments/charge.js', 60); // 既定の risk パターンには非該当だが conf の追加分に一致
  const head = commit(dir, 'change');

  const out = parseJsonOutput(runScript(['--dir', dir, '--base', base, '--head', head]));

  // 既定の threshold(100) なら60行はSだが、conf の threshold_m=50 上書きでMになるはず
  assert.equal(out.size, 'M', 'threshold_m の conf 上書きが効いていない');
  assert.equal(out.risk, 'HIGH', 'conf の risk: 追加が効いていない');
  assert.deepEqual(out.matched_risk_paths, ['src/payments/charge.js']);
  // §3.1: conf 自身の変更 warning は「conf パース由来より後ろ」に決定的に追加される。
  // 順序をアサートすることで、この決定性そのものを固定する。
  assert.equal(out.warnings.length, 2, 'conf 変更 warning が追加されていない');
  // §3.1改訂 / AC22: 解釈できない行の中身は出さず行番号だけを出す（symlink 経由の秘密漏洩対策）。
  assert.doesNotMatch(
    out.warnings[0],
    /bogus_line_here/,
    '解釈できない行の中身が warning に残っている（AC22 の行番号のみ原則に反する）',
  );
  assert.match(out.warnings[0], /4\s*行目/, '解釈できない行（4行目）の行番号が warning に含まれていない');
  // 2件目は緩和方向（exclude: 追加）の warning。.agent/size-tier.conf はどちらの warning にも
  // 入りうるので、逸脱の種類（exclude）まで見て2つを区別する。
  assert.match(out.warnings[1], /exclude/, '緩和方向（exclude 追加）の種類が warning から分からない');
  assert.match(
    out.warnings[1],
    /\.agent\/size-tier\.conf/,
    'conf 自身の変更 warning が末尾に無い（§3.1）',
  );
});

test('AC7: risk_reset は既定リスクパターンを落とし、追加分だけが残る', (t) => {
  const { dir, base } = newBaseRepo(t);
  writeText(dir, '.agent/size-tier.conf', ['risk_reset', 'risk: custom/riskonly/**', ''].join('\n'));
  // 既定なら **/api/** に一致するはずのパス。risk_reset 後は一致してはいけない。
  writeLines(dir, 'src/api/legacy.js', 10);
  writeLines(dir, 'custom/riskonly/thing.js', 10);
  const head = commit(dir, 'change');

  const out = parseJsonOutput(runScript(['--dir', dir, '--base', base, '--head', head]));

  assert.equal(out.risk, 'HIGH');
  assert.deepEqual(
    out.matched_risk_paths,
    ['custom/riskonly/thing.js'],
    'risk_reset 後も既定パターン（**/api/**）が残っている',
  );
  // §3.1: risk_reset は既定リスクを無効化する変更そのものなので、無音で通してはいけない。
  assert.ok(
    out.warnings.some((w) => w.includes('.agent/size-tier.conf')),
    'conf 変更（risk_reset を含む）の warning が記録されていない',
  );
});

test('AC7: exclude_reset は既定除外パターンを落とし、追加分だけが残る', (t) => {
  const { dir, base } = newBaseRepo(t);
  writeText(dir, '.agent/size-tier.conf', ['exclude_reset', 'exclude: **/customignore/**', ''].join('\n'));
  // 既定なら除外されるはずの lockfile。exclude_reset 後はサイズに含まれるべき。
  writeLines(dir, 'package-lock.json', 40);
  writeLines(dir, 'customignore/data.json', 25);
  const head = commit(dir, 'change');

  const out = parseJsonOutput(runScript(['--dir', dir, '--base', base, '--head', head]));

  assert.equal(out.lines, 40, 'exclude_reset 後も package-lock.json が除外されたままになっている');
  assert.deepEqual(out.excluded_paths, ['customignore/data.json']);
  assert.equal(out.size, 'S');
  // §3.1: exclude_reset も既定除外を無効化する変更なので同様に warning が要る。
  assert.ok(
    out.warnings.some((w) => w.includes('.agent/size-tier.conf')),
    'conf 変更（exclude_reset を含む）の warning が記録されていない',
  );
});

// --- AC8: test_ledger の S 分岐（テストファイル変更の有無）------------------

test('AC8: S かつテストファイル変更あり → test_ledger は post_pr', (t) => {
  const { dir, base } = newBaseRepo(t);
  writeLines(dir, 'src/foo.test.js', 30);
  const head = commit(dir, 'change');

  const out = parseJsonOutput(runScript(['--dir', dir, '--base', base, '--head', head]));

  assert.equal(out.size, 'S');
  assert.equal(out.gates.test_ledger, 'post_pr');
});

test('AC8: S かつテストファイル変更なし → test_ledger は skip', (t) => {
  const { dir, base } = newBaseRepo(t);
  writeLines(dir, 'src/foo.util.js', 30);
  const head = commit(dir, 'change');

  const out = parseJsonOutput(runScript(['--dir', dir, '--base', base, '--head', head]));

  assert.equal(out.size, 'S');
  assert.equal(out.gates.test_ledger, 'skip');
});

// --- AC9: base == head（差分なし）は正常系で S / fallback:false -------------

test('AC9: base と head が同じコミットなら lines:0 / size:S / fallback:false', (t) => {
  const { dir, base } = newBaseRepo(t);

  const out = parseJsonOutput(runScript(['--dir', dir, '--base', base, '--head', base]));

  assert.equal(out.lines, 0);
  assert.equal(out.files, 0);
  assert.equal(out.size, 'S');
  assert.equal(out.fallback, false);
  assert.deepEqual(out.matched_risk_paths, []);
  assert.deepEqual(out.excluded_paths, []);
  assert.deepEqual(out.scopes, []);
});

// --- AC10（§3.1 改訂）: 判定設定ファイル自身の警告は state ベース --------------
// 旧 AC10（廃止）は conf を diff に含めた fixture で「diff に conf が現れたら warning」を
// 検証していたが、実配置では .agent/ が gitignore（doc-standard 規約）されているため
// conf は diff に一切現れず、旧仕様の警告は原理的に一度も鳴らなかった（実測: Critical X-3）。
// 新仕様は「diff に現れたか」ではなく「今読み込んだ conf が既定を緩めているか」を見るので、
// この fixture では conf を意図的に git 管理外（gitignore 対象）に置く。

test('AC10: .gitignore で .agent/ を除外した規約準拠リポでも、conf が diff に現れないまま warnings に記録される', (t) => {
  const dir = initRepo(t, { branch: 'main' });
  // 実配置（doc-standard 規約）を模す: .agent/ は最初から gitignore されている。
  writeText(dir, '.gitignore', '.agent/\n');
  writeLines(dir, 'README.md', 3);
  const base = commit(dir, 'base（.gitignore 込み）');

  // risk_reset だけの conf を置く。gitignore 対象なので commit() の git add -A では拾われない。
  writeText(dir, '.agent/size-tier.conf', 'risk_reset\n');
  // 既定なら **/api/** に一致して HIGH になるはずのパス。risk_reset が効いていれば LOW のまま。
  writeLines(dir, 'src/api/users.ts', 50);
  const head = commit(dir, 'change（conf は gitignore 済みなので diff に含まれない）');

  // sanity: conf が本当に diff に現れていないことを確認しておく（fixture 側の前提チェック）。
  const trackedPaths = git(dir, ['diff', '--name-only', base, head]).trim().split('\n');
  assert.ok(
    !trackedPaths.includes('.agent/size-tier.conf'),
    'fixture の前提が崩れている: conf が diff に含まれてしまっている',
  );

  const out = parseJsonOutput(runScript(['--dir', dir, '--base', base, '--head', head]));

  // conf 自体は diff に無いので size/risk への直接の寄与はゼロ（あるのは users.ts の50行のみ）。
  assert.equal(out.size, 'S');
  // risk_reset が state として効いていれば LOW（旧実装のバグはここが HIGH のまま or LOW/warnings:[] だった）。
  assert.equal(out.risk, 'LOW');
  assert.equal(out.lines, 50);
  assert.equal(out.files, 1);
  assert.deepEqual(out.matched_risk_paths, []);
  // 「昇格させない」ことも同時に固定する。将来 conf 変更を HIGH に昇格させる実装に変わったら、
  // このテストが落ちて気づける（契約 §3.1「サイズ・リスクは昇格させない」）。
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0], /\.agent\/size-tier\.conf/);
});

// --- AC11（X-10）: フォールバック時の gates も deep equal で固定する ---------
// レンズ A の生存ミューテーション M8: fallback() の gates を L×HIGH → S×LOW にすり替えても
// AC4/AC4b は size/risk/fallback_reason しか見ていないため 19/19 pass していた。
// 「表向き size:L risk:HIGH と言いながら中身は最軽量ゲート」という最も気づきにくい
// fail-open を、gates の deep equal で塞ぐ。

const FALLBACK_GATES = {
  adversarial_lenses: ['A', 'B', 'C', 'D'],
  code_reviewer: 'per_phase',
  self_review_members: SELF_REVIEW_ML,
  security_review: true,
  test_ledger: 'pre_pr',
  explain_diff: 'post_pr',
  // 証拠（scopes）が取れないので重い側に固定する。matched_risk_paths が [] のまま
  // risk:"HIGH" になる既存のフォールバックと同じ形（契約 §7）。
  qa: 'required',
};

test('AC11: AC4（非gitディレクトリ）のフォールバックでも gates が L×HIGH で固定されている', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assess-size-notgit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const out = parseJsonOutput(runScript(['--dir', dir]));

  assert.equal(out.fallback, true);
  assert.deepEqual(out.gates, FALLBACK_GATES, 'フォールバック時の gates が L×HIGH になっていない');
});

test('AC11: AC4b（base 未解決）のフォールバックでも gates が L×HIGH で固定されている', (t) => {
  const dir = initRepo(t, { branch: 'work' });
  writeLines(dir, 'README.md', 3);
  commit(dir, 'init');

  const out = parseJsonOutput(runScript(['--dir', dir]));

  assert.equal(out.fallback, true);
  assert.deepEqual(out.gates, FALLBACK_GATES, 'フォールバック時の gates が L×HIGH になっていない');
});

// --- AC12（X-1）: rename されたパスもリスク照合が効く（--no-renames）---------
// git diff --numstat はデフォルトで rename を `src/{util => auth}/x.ts` という合成表記に
// まとめる。素の文字列として glob 照合するとリテラル `/auth/` が存在せず一致しない
// （実際にあるのは `=> auth}/`）。--no-renames を付けて「削除+追加」の2エントリに割ることで
// 新パスがそのまま照合対象になる。

test('AC12: risk パスへの rename が HIGH として検出され、純 rename の lines は 2×N になる', (t) => {
  const { dir, base } = newBaseRepo(t);
  writeLines(dir, 'src/util/big.ts', 60);
  const preRename = commit(dir, 'add file at non-risk path');
  // この環境の git（2.43.0）は git mv の移動先ディレクトリを自動作成しない
  // （通常の git mv の挙動と異なる。作らずに呼ぶと「そのようなファイルやディレクトリはありません」で落ちる）。
  fs.mkdirSync(path.join(dir, 'src', 'auth'), { recursive: true });
  git(dir, ['mv', 'src/util/big.ts', 'src/auth/big.ts']);
  const head = commit(dir, 'rename into risk path (no content change)');

  const out = parseJsonOutput(runScript(['--dir', dir, '--base', preRename, '--head', head]));

  assert.equal(out.risk, 'HIGH', 'rename 先が risk パスなのに合成表記のまま照合され LOW になっている');
  assert.deepEqual(out.matched_risk_paths, ['src/auth/big.ts']);
  assert.equal(out.lines, 120, '--no-renames で純 rename が削除+追加(2×60行)として数えられていない');
  assert.equal(out.size, 'M');
});

// --- AC13（X-1 / Y）: conf 自身の rename でも §3.1 の警告が出る -------------
// 警告は diff ではなく state（$ROOT/.agent/size-tier.conf の現在の中身）を見るので、
// rename の経路がどうであれ HEAD 時点で conf が既定を緩めていれば警告は出るはず。
// あわせて、rename で生成される2エントリのうち正規パス側（.agent/size-tier.conf）だけが
// files/lines から除外され、旧パス側は通常ファイルとして数えられることを確認する。

test('AC13: 別名から .agent/size-tier.conf へ rename された conf でも warning が出て files に数えない', (t) => {
  const dir = initRepo(t, { branch: 'main' });
  writeLines(dir, 'README.md', 3);
  // まだ認識されないファイル名なので、この時点では conf として読まれない。
  writeText(dir, '.agent/other-name.conf', 'risk_reset\n');
  const base = commit(dir, 'base（未認識の名前で conf 相当のファイルを追加）');

  git(dir, ['mv', '.agent/other-name.conf', '.agent/size-tier.conf']);
  const head = commit(dir, 'rename into canonical conf path');

  const out = parseJsonOutput(runScript(['--dir', dir, '--base', base, '--head', head]));

  assert.ok(
    out.warnings.some((w) => w.includes('.agent/size-tier.conf')),
    'rename 経由で conf が現れても §3.1 の警告が出ていない',
  );
  // --no-renames で 2 エントリに割れる: 旧パス(削除1行, 除外対象外) + 新パス(追加1行, §3.1 除外)。
  assert.equal(out.files, 1, '.agent/size-tier.conf 側が files に含まれてしまっている');
  assert.equal(out.lines, 1, '.agent/size-tier.conf 側が lines に含まれてしまっている');
  assert.equal(out.risk, 'LOW');
  assert.deepEqual(out.matched_risk_paths, []);
});

// --- AC14（X-2）: 非ASCIIパスの core.quotepath 8進エスケープ対策 -------------
// git は既定（core.quotepath=true）で非ASCIIパスを "\NNN...\NNN" という8進エスケープ済みの
// ダブルクォート文字列で出力する。-c core.quotepath=false を付けないと、リスク照合が
// 一致しないだけでなく matched_risk_paths に実在しないパス文字列が載る。

test('AC14: 非ASCIIパス（日本語ディレクトリ）が risk:"HIGH" になり、実在するパスがそのまま載る', (t) => {
  const { dir, base } = newBaseRepo(t);
  // 既定のリスクパターンは全て ASCII の英単語（**/auth/** 等）なので、glob は
  // auth と 認証 を結び付けない。conf で非ASCIIパターンを設定した状態で検証する
  // （レンズ D の元の再現手順 .agent/adversarial-review-34-phase1-D.md:182 と同じ条件）。
  writeText(dir, '.agent/size-tier.conf', 'risk: **/認証/**\n');
  writeLines(dir, 'src/認証/token.ts', 20);
  const head = commit(dir, 'add non-ascii path');

  const out = parseJsonOutput(runScript(['--dir', dir, '--base', base, '--head', head]));

  assert.equal(out.risk, 'HIGH');
  assert.deepEqual(
    out.matched_risk_paths,
    ['src/認証/token.ts'],
    '8進エスケープ・ダブルクォート付きの偽パスになっている',
  );
});

test('AC14: 非ASCIIディレクトリ配下の Dockerfile も HIGH になる', (t) => {
  const { dir, base } = newBaseRepo(t);
  writeLines(dir, 'インフラ/Dockerfile', 5);
  const head = commit(dir, 'add dockerfile under non-ascii dir');

  const out = parseJsonOutput(runScript(['--dir', dir, '--base', base, '--head', head]));

  assert.equal(out.risk, 'HIGH');
  assert.deepEqual(out.matched_risk_paths, ['インフラ/Dockerfile']);
});

// --- AC15（X-4）: --dir にサブディレクトリを渡してもルート基準で判定する ------
// --dir 直下から conf を探すと、サブディレクトリを渡したときに
// リポジトリルートの conf が読まれず／diff はルート相対パスのままという座標系のズレが起きる。
// git rev-parse --show-toplevel でルートに解決してから conf 探索・diff 双方を行う必要がある。
//
// diff.relative=true は「git -C "$ROOT" で常に呼ぶ」という §1 の不変条件に依存した
// 偶然の正しさ（cd してから呼んだ場合だけ座標系が壊れる）だったため、-c diff.relative=false を
// 明示的に固定する契約変更が入った。この fixture にリポジトリ側で diff.relative=true を
// 設定しておくことで、その固定が効いていることの回帰テストを兼ねる。

test('AC15: --dir にサブディレクトリを渡してもリポジトリルートの conf が読まれ、ルート実行と一致する', (t) => {
  const { dir, base } = newBaseRepo(t);
  writeText(dir, '.agent/size-tier.conf', 'threshold_m=20\nthreshold_l=50\nrisk: packages/web/**\n');
  writeLines(dir, 'packages/web/app.ts', 60);
  const head = commit(dir, 'change under subdir');
  // リポジトリ側の設定で diff.relative=true にしても、-c diff.relative=false で
  // 上書きされ、パスが常にルート相対（packages/web/app.ts）のままであることを確認する。
  git(dir, ['config', 'diff.relative', 'true']);

  const fromRoot = parseJsonOutput(runScript(['--dir', dir, '--base', base, '--head', head]));
  const subDir = path.join(dir, 'packages', 'web');
  const fromSubdir = parseJsonOutput(runScript(['--dir', subDir, '--base', base, '--head', head]));

  // threshold_l=50 の上書きが効いていれば 60 行は L（>50）。conf が読めていないと既定(500)で M になる。
  assert.equal(fromRoot.size, 'L');
  assert.equal(fromRoot.risk, 'HIGH');
  assert.deepEqual(fromSubdir, fromRoot, '--dir にサブディレクトリを渡すとルート実行と判定が一致しない');
});

// --- AC16（X-5）: GIT_DIR/GIT_WORK_TREE に負けず --dir を優先する ------------
// git -C は cwd を変えるだけで、環境変数 GIT_DIR の方が優先される。
// git hook 実行中や rebase --exec 等ではこれらが git 自身により export されるため、
// スクリプト冒頭で明示的に unset しておかないと --dir が無視され別リポジトリを判定する。

test('AC16: GIT_DIR/GIT_WORK_TREE が別リポジトリを指していても --dir で指定したリポジトリを判定する', (t) => {
  const { dir: dirA, base: baseA } = newBaseRepo(t);
  writeLines(dirA, 'src/api/users.ts', 50);
  const headA = commit(dirA, 'change A（risk HIGH のはず）');

  // 差分ゼロの別リポジトリ（B）。GIT_DIR/GIT_WORK_TREE がここを指すように環境変数だけ細工する。
  const dirB = initRepo(t, { branch: 'main' });
  writeLines(dirB, 'README.md', 3);
  commit(dirB, 'base B');

  const res = spawnSync('bash', [SCRIPT, '--dir', dirA, '--base', baseA, '--head', headA], {
    encoding: 'utf8',
    env: { ...GIT_ENV, GIT_DIR: path.join(dirB, '.git'), GIT_WORK_TREE: dirB },
    cwd: NEUTRAL_CWD,
  });
  const out = parseJsonOutput(res);

  assert.equal(out.risk, 'HIGH', 'GIT_DIR/GIT_WORK_TREE に負けて別リポジトリ（B、差分ゼロ）を判定している');
  assert.equal(out.lines, 50);
});

// --- AC17（X-6）: ** を含むパターンが畳み込み前処理なしで一致する ------------
// ${pat//\*\*/\*} は bash 4.2 以前（macOS 標準 /bin/bash は 3.2）で `\*/api/\*` になり
// / を含む全パターンの照合が死ぬ。畳み込みは不要（生の ** のままでも [[ == ]] は / を跨いで
// 一致する）ため、そもそも前処理をしないことで bash バージョン依存を断つ。

test('AC17: ** を含むリスクパターンが畳み込み前処理なしで一致する（BASH_COMPAT=42 でも一致）', (t) => {
  const { dir, base } = newBaseRepo(t);
  writeLines(dir, 'src/api/users.ts', 50);
  const head = commit(dir, 'change');

  const normal = parseJsonOutput(runScript(['--dir', dir, '--base', base, '--head', head]));
  assert.equal(normal.risk, 'HIGH');

  const resCompat = spawnSync('bash', [SCRIPT, '--dir', dir, '--base', base, '--head', head], {
    encoding: 'utf8',
    env: { ...GIT_ENV, BASH_COMPAT: '42' },
    cwd: NEUTRAL_CWD,
  });
  const compat = parseJsonOutput(resCompat);

  assert.equal(compat.risk, 'HIGH', 'BASH_COMPAT=42（bash 4.2 互換の意味論）で ** パターンの照合が壊れている');
  assert.deepEqual(compat, normal, 'BASH_COMPAT の有無で判定結果が変わってはいけない');
});

// --- AC18（X-7）: --base "" / 存在しない ref はフォールバックする ------------
// --base "" を渡すと base 自動検出がスキップされ `git diff ...HEAD` が実行される。
// これは git 的には HEAD...HEAD と等価な正当な指定で「差分ゼロ」を返すため、
// 実在確認（git rev-parse --verify）をしないと「差分なしの正常系」に誤解釈されてしまう。

test('AC18: --base "" は差分ゼロと誤解釈されずフォールバックする', (t) => {
  const { dir, base } = newBaseRepo(t);
  writeLines(dir, 'src/api/users.ts', 50);
  const head = commit(dir, 'change');
  void base; // このテストでは意図的に --base "" を渡すので使わない

  const out = parseJsonOutput(runScript(['--dir', dir, '--base', '', '--head', head]));

  assert.equal(out.fallback, true);
  assert.equal(out.size, 'L');
  assert.equal(out.risk, 'HIGH');
  assert.notEqual(out.fallback_reason, '');
});

test('AC18: 存在しない --base ref はフォールバックする', (t) => {
  const { dir } = newBaseRepo(t);
  writeLines(dir, 'src/api/users.ts', 50);
  const head = commit(dir, 'change');

  const out = parseJsonOutput(
    runScript(['--dir', dir, '--base', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', '--head', head]),
  );

  assert.equal(out.fallback, true);
  assert.equal(out.size, 'L');
  assert.equal(out.risk, 'HIGH');
});

// --- AC19（X-8）: --base 経由の git オプション注入を無効化する ---------------
// `git diff --numstat "${BASE}...${HEAD_REF}" --` は `--` がリビジョンの後ろにあるため
// オプション解析を止めていない。--base "--output=<path>" を渡すと任意パスへの書き込みが起き、
// かつ diff 本体がファイルへ逸れて「変更なし」＝最軽量判定になる。--end-of-options で塞ぐ。

test('AC19: --base に git オプションを注入してもファイルが作られず、フォールバックする', (t) => {
  const { dir } = newBaseRepo(t);
  writeLines(dir, 'src/api/users.ts', 50);
  const head = commit(dir, 'change');
  const attackTargetDir = makeFixtureDir(t);
  const attackTarget = path.join(attackTargetDir, 'PWNED');

  const out = parseJsonOutput(runScript(['--dir', dir, '--base', `--output=${attackTarget}`, '--head', head]));

  assert.deepEqual(
    fs.readdirSync(attackTargetDir),
    [],
    '--base 経由の git オプション注入で任意パスへファイルが書き込まれている',
  );
  assert.equal(
    out.fallback,
    true,
    'オプション注入された --base は実在するコミットに解決できないのでフォールバックすべき',
  );
});

// --- AC20（X-9）: ケース非依存でリスク照合する（スコープを漏らさない）--------
// src/Auth/ src/Api/ は .NET/Java 系では標準的な命名だが、素の [[ == ]] はケースセンシティブ
// なので素通りする。shopt -s nocasematch は照合関数の中だけで on/off し、
// conf のパス完全一致比較やテストファイル判定にまで波及させてはいけない。

test('AC20: src/Auth/ や src/API/ のような大文字混じりパスも risk:"HIGH" になる（ケース非依存）', (t) => {
  const { dir, base } = newBaseRepo(t);
  writeLines(dir, 'src/Auth/login.ts', 10);
  writeLines(dir, 'src/API/users.ts', 10);
  const head = commit(dir, 'change');

  const out = parseJsonOutput(runScript(['--dir', dir, '--base', base, '--head', head]));

  assert.equal(out.risk, 'HIGH');
  assert.deepEqual(
    [...out.matched_risk_paths].sort(),
    ['src/API/users.ts', 'src/Auth/login.ts'].sort(),
  );
});

test('AC20: nocasematch がテストファイル判定に漏れていない（大文字化した *.TEST.JS は skip のまま）', (t) => {
  const { dir, base } = newBaseRepo(t);
  writeLines(dir, 'SRC/FOO.TEST.JS', 10);
  const head = commit(dir, 'change');

  const out = parseJsonOutput(runScript(['--dir', dir, '--base', base, '--head', head]));

  assert.equal(out.size, 'S');
  assert.equal(
    out.gates.test_ledger,
    'skip',
    'nocasematch がテストファイル判定（*.test.* 等）にまで漏れている',
  );
});

test('AC20: nocasematch が conf パスの完全一致比較に漏れていない', (t) => {
  const { dir, base } = newBaseRepo(t);
  // 大文字化した偽の conf パス。正規の .agent/size-tier.conf とは別パスなので、
  // §3.1 の除外・warning のどちらにも該当してはならない（通常ファイルとして数えられるべき）。
  writeText(dir, '.AGENT/SIZE-TIER.CONF', 'risk_reset\n');
  writeLines(dir, 'src/util/plain.js', 10);
  const head = commit(dir, 'change');

  const out = parseJsonOutput(runScript(['--dir', dir, '--base', base, '--head', head]));

  assert.equal(out.files, 2, '大文字パスの偽 conf が正規 conf として除外されている（nocasematch 漏れ）');
});

// --- AC21（Y-1）: conf が symlink のとき読まずに warning・リンク先は一切出さない ---
// .agent/size-tier.conf は git が mode 120000（symlink）として配送できるため、
// PR 経由で任意ファイルへのシンボリックリンクを送り込める。解釈できない行の中身を
// そのまま warnings に載せる実装と組み合わさると、リポジトリ外の秘密情報が判定 JSON に流れ込む。

test('AC21: conf が symlink のとき読まずに warnings を出し、リンク先の中身が出力に一切現れない', (t) => {
  const { dir, base } = newBaseRepo(t);
  const secretDir = makeFixtureDir(t);
  const secretFile = path.join(secretDir, 'fake.env');
  const secretToken = 'FAKE-TOKEN-abcdef123456';
  fs.writeFileSync(secretFile, `KINTONE_API_TOKEN=${secretToken}\n`);

  fs.mkdirSync(path.join(dir, '.agent'), { recursive: true });
  fs.symlinkSync(secretFile, path.join(dir, '.agent', 'size-tier.conf'));
  writeLines(dir, 'src/util/plain.js', 10);
  const head = commit(dir, 'change with symlinked conf');

  const res = runScript(['--dir', dir, '--base', base, '--head', head]);
  const out = parseJsonOutput(res);

  assert.ok(
    !res.stdout.includes(secretToken) && !res.stdout.includes('KINTONE_API_TOKEN'),
    'symlink 先の秘密情報が出力に漏れている',
  );
  assert.ok(
    out.warnings.some((w) => w.includes('.agent/size-tier.conf')),
    'symlink を検出した warning が出ていない',
  );
});

// --- AC22（Y-1）: 解釈できない行は行番号だけを出し、中身は出さない -----------
// 「解釈できない conf 行: <行そのもの>」という形で中身ごと warnings に載せると、
// symlink と組み合わさらなくても conf に直接書かれた秘密情報・後続 Claude への
// 指示文（プロンプトインジェクション）がそのまま流れる。中身を出さず行番号だけにする。

test('AC22: 解釈できない conf 行は行番号だけが warnings に出て、行の中身は出力に現れない', (t) => {
  const { dir, base } = newBaseRepo(t);
  const secretLine = 'DB_PASSWORD=FAKE-hunter2-should-not-leak';
  writeText(dir, '.agent/size-tier.conf', `threshold_m=100\n${secretLine}\n`);
  writeLines(dir, 'src/util/plain.js', 10);
  const head = commit(dir, 'change with bad conf line');

  const res = runScript(['--dir', dir, '--base', base, '--head', head]);
  const out = parseJsonOutput(res);

  assert.ok(!res.stdout.includes('DB_PASSWORD'), '解釈できない行の中身（DB_PASSWORD）が出力に残っている');
  assert.ok(!res.stdout.includes('FAKE-hunter2'), '解釈できない行の中身が出力に残っている');
  assert.ok(
    out.warnings.some((w) => /\d+\s*行目/.test(w)),
    '行番号を含む warning になっていない（中身の代わりに何行目かが分からない）',
  );
});

// --- AC23（§2.1 / Y-2）: 制御文字が混ざっても JSON.parse できる --------------
// json_escape が \ と " しかエスケープしないと、conf の行やパス名に含まれる制御文字
// （U+0000-U+001F）が生のまま出力され JSON として不正になる。フォールバックもしないので
// exit 0 のまま壊れた JSON が出る＝fail-safe が効かない領域になる。

test('AC23: conf に制御文字（ESC・BEL 等）を含めても出力が JSON.parse できる', (t) => {
  const { dir, base } = newBaseRepo(t);
  const controlLine = 'weird\x1b[31mred\x07bell\x0bvt\x0cff-line';
  writeText(dir, '.agent/size-tier.conf', `threshold_m=100\n${controlLine}\n`);
  writeLines(dir, 'src/util/plain.js', 10);
  const head = commit(dir, 'change with control chars in conf');

  const res = runScript(['--dir', dir, '--base', base, '--head', head]);

  assert.equal(res.status, 0);
  assert.doesNotThrow(() => JSON.parse(res.stdout.trim()), 'JSON.parse に失敗した＝制御文字のエスケープが漏れている');
});

test('AC23: パス名に制御文字（タブ）を含めても出力が JSON.parse できる', (t) => {
  const { dir, base } = newBaseRepo(t);
  const weirdName = 'src/weird\tname.js';
  writeLines(dir, weirdName, 10);
  const head = commit(dir, 'change with control char in filename');

  const res = runScript(['--dir', dir, '--base', base, '--head', head]);

  assert.equal(res.status, 0);
  assert.doesNotThrow(
    () => JSON.parse(res.stdout.trim()),
    'JSON.parse に失敗した＝パス名の制御文字エスケープが漏れている',
  );
});

// --- AC24（Y-3）: conf の読み込み上限・warnings の件数上限 -------------------
// conf の行数・バイト数が無制限だと、全行を読み WARNINGS に蓄積する処理と
// O(n²) の json_array 連結が組み合わさって判定器自体がハングし「フォールバック時も
// 必ず JSON を出す」という契約の中核が破れる（実測: 200,000行の conf で60秒タイムアウト・出力0バイト）。

test('AC24: conf が200行を超えると打ち切られ、超過分の設定は適用されない', (t) => {
  const { dir, base } = newBaseRepo(t);
  const fillerLines = Array.from({ length: 205 }, (_, i) => `# filler ${i}`);
  // 200行を超えた位置に置く。打ち切りが効いていれば、この上書きは無視され既定 threshold_m=100 のまま。
  fillerLines.push('threshold_m=1');
  writeText(dir, '.agent/size-tier.conf', fillerLines.join('\n') + '\n');
  writeLines(dir, 'src/util/plain.js', 50);
  const head = commit(dir, 'change with 200+ line conf');

  const out = parseJsonOutput(runScript(['--dir', dir, '--base', base, '--head', head]));

  assert.equal(out.size, 'S', '200行超の conf の threshold_m=1 が適用されている（打ち切りが効いていない）');
  assert.ok(
    out.warnings.some((w) => /200|行数|超/.test(w)),
    '行数上限を超えたことの warning が出ていない',
  );
});

test('AC24: conf が64KBを超えると読み込まれず、既定値で判定する', (t) => {
  const { dir, base } = newBaseRepo(t);
  const bigComment = '# ' + 'x'.repeat(70000);
  // 2行だけなので行数上限(200行)には引っかからない。バイト数だけが上限を超えている。
  writeText(dir, '.agent/size-tier.conf', `${bigComment}\nthreshold_m=1\n`);
  writeLines(dir, 'src/util/plain.js', 50);
  const head = commit(dir, 'change with 64KB+ conf');

  const out = parseJsonOutput(runScript(['--dir', dir, '--base', base, '--head', head]));

  assert.equal(out.size, 'S', '64KB超の conf の threshold_m=1 が適用されている（バイト数上限が効いていない）');
  assert.ok(
    out.warnings.some((w) => /KB|バイト|サイズ/.test(w)),
    'バイト数上限を超えたことの warning が出ていない',
  );
});

test('AC24: warnings は20件を超えず、超過分は要約1件にまとめられる', (t) => {
  const { dir, base } = newBaseRepo(t);
  // 200行・64KB のどちらの上限にも触れない範囲で、解釈不能な行だけを30本作る。
  const garbageLines = Array.from({ length: 30 }, (_, i) => `bogus_directive_${i}`);
  writeText(dir, '.agent/size-tier.conf', garbageLines.join('\n') + '\n');
  writeLines(dir, 'src/util/plain.js', 10);
  const head = commit(dir, 'change with 30 unparseable conf lines');

  const out = parseJsonOutput(runScript(['--dir', dir, '--base', base, '--head', head]));

  assert.ok(out.warnings.length <= 21, `warnings が上限を超えている: ${out.warnings.length}件`);
  assert.match(
    out.warnings[out.warnings.length - 1],
    /他.*\d+.*件.*省略/,
    '省略件数の要約メッセージが末尾に無い',
  );
});

// --- AC25（Y-4）: 閾値・空値の検証 ------------------------------------------
// threshold_m > threshold_l の矛盾・8進解釈される先頭ゼロ・空値を無音で受理すると、
// M 帯が丸ごと潰れたり、閾値が意図しない別の数として扱われたりする。

test('AC25: threshold_m > threshold_l の矛盾は両方とも既定値に戻り、warning が出る', (t) => {
  const { dir, base } = newBaseRepo(t);
  writeText(dir, '.agent/size-tier.conf', 'threshold_m=5000\nthreshold_l=100\n');
  // 既定(100,500)なら M、矛盾した conf がそのまま適用されるなら(threshold_m=5000) S になってしまう。
  writeLines(dir, 'src/util/plain.js', 300);
  const head = commit(dir, 'change with inverted thresholds');

  const out = parseJsonOutput(runScript(['--dir', dir, '--base', base, '--head', head]));

  assert.equal(out.size, 'M', 'threshold_m > threshold_l の矛盾 conf が既定値に戻っていない');
  assert.ok(out.warnings.length > 0, '閾値矛盾の warning が出ていない');
});

test('AC25: threshold_m=08 は8進として解釈させず拒否し、既定値を使う', (t) => {
  const { dir, base } = newBaseRepo(t);
  writeText(dir, '.agent/size-tier.conf', 'threshold_m=08\n');
  // 既定(threshold_m=100)なら 50 行は S。8進(8)がそのまま通ると 50>=8 で M になってしまう。
  writeLines(dir, 'src/util/plain.js', 50);
  const head = commit(dir, 'change with leading-zero threshold');

  const out = parseJsonOutput(runScript(['--dir', dir, '--base', base, '--head', head]));

  assert.equal(out.size, 'S', 'threshold_m=08 が8進(8)として解釈され既定値に戻っていない');
  assert.ok(out.warnings.length > 0, '先頭ゼロを拒否した warning が出ていない');
});

test('AC25: threshold_m= のような空値は拒否し、既定値を使う', (t) => {
  const { dir, base } = newBaseRepo(t);
  writeText(dir, '.agent/size-tier.conf', 'threshold_m=\n');
  writeLines(dir, 'src/util/plain.js', 50);
  const head = commit(dir, 'change with empty threshold value');

  const out = parseJsonOutput(runScript(['--dir', dir, '--base', base, '--head', head]));

  assert.equal(out.size, 'S', '空値の threshold_m が既定値に戻っていない');
  assert.ok(out.warnings.length > 0, '空値を拒否した warning が出ていない');
});

test('AC25: 値が空の risk: 行は無音で捨てず warning を出す（risk_reset との組み合わせでも）', (t) => {
  const { dir, base } = newBaseRepo(t);
  // risk_reset + 値なしの risk: という組み合わせは「既定リスクを全部捨てて代わりに何も足さない」
  // ＝全リスク判定の無効化が warnings 完全ゼロで成立してしまう、契約 §3.1 が名指しで防ごうとした形。
  writeText(dir, '.agent/size-tier.conf', 'risk_reset\nrisk:\n');
  writeLines(dir, 'src/api/u.ts', 5);
  const head = commit(dir, 'change with risk_reset + empty risk:');

  const out = parseJsonOutput(runScript(['--dir', dir, '--base', base, '--head', head]));

  assert.equal(out.risk, 'LOW');
  assert.ok(
    out.warnings.some((w) => w.includes('.agent/size-tier.conf')),
    '§3.1 の緩和 warning（risk_reset）が出ていない',
  );
  assert.ok(
    out.warnings.length >= 2,
    '値が空の risk: 行についての warning が出ていない（無音で捨てられている）',
  );
});

// --- AC26（Y-5）: conf が読めないとき warning を出す -------------------------
// conf がディレクトリ、あるいは権限で読めない場合、-f が偽／リダイレクトが失敗するだけで
// 無音で既定値に退避していた。行単位の異常より重大な「ファイルごと読めない」が
// 行単位より静かになっているのは §8 の「無音で落とさない」の趣旨に反する。

test('AC26: conf がディレクトリの場合 warnings に1件出て既定値で判定する', (t) => {
  const { dir, base } = newBaseRepo(t);
  fs.mkdirSync(path.join(dir, '.agent', 'size-tier.conf'), { recursive: true });
  writeLines(dir, 'src/util/plain.js', 50);
  const head = commit(dir, 'change with conf-as-directory');

  const out = parseJsonOutput(runScript(['--dir', dir, '--base', base, '--head', head]));

  assert.equal(out.size, 'S');
  assert.ok(
    out.warnings.some((w) => w.includes('.agent/size-tier.conf')),
    'conf がディレクトリのケースで warnings が出ていない',
  );
});

test('AC26: conf のパーミッションで読めない場合 warnings に1件出て既定値で判定する', (t) => {
  // root はパーミッションを無視して読めてしまうため、この検証は非root環境限定。
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('root では chmod 000 でも読めてしまうため検証できない');
    return;
  }

  const { dir, base } = newBaseRepo(t);
  // conf が読める状態でコミットしてから chmod する（git add 自体が読み取りを要求するため）。
  writeText(dir, '.agent/size-tier.conf', 'threshold_m=1\n');
  writeLines(dir, 'src/util/plain.js', 50);
  const head = commit(dir, 'change with conf (readable at commit time)');
  const confPath = path.join(dir, '.agent', 'size-tier.conf');
  fs.chmodSync(confPath, 0o000);
  t.after(() => {
    try {
      fs.chmodSync(confPath, 0o644);
    } catch {
      // ignore
    }
  });

  const out = parseJsonOutput(runScript(['--dir', dir, '--base', base, '--head', head]));

  assert.equal(out.size, 'S', '読めない conf の threshold_m=1 が適用されている（無音フォールバック疑い）');
  assert.ok(
    out.warnings.some((w) => w.includes('.agent/size-tier.conf')),
    '読めない conf について warnings が出ていない',
  );
});

// --- AC27: 秘密の読み込み経路と公開境界（Phase 1.5 キャリブレーション由来）-------
// 実 PR 32件を測ったところ、Ansible でサーバを構築する infra リポジトリの HIGH 率が
// 21件中1件（5%）だった。既定パターンがアプリ層中心で、Vault 変数・nginx 設定・
// terraform を1つも含んでいなかったため。「Vault 変数が読み込まれない不具合の修正」が
// S/LOW に倒れるのは Issue #34 が最も避けたい失敗モードそのもの。
// 詳細と選択肢の実測比較は .agent/calibration-34-phase15.md §4。

// 概念ごとに「基底名形」と「ディレクトリ形」を1本ずつ独立して回す。
// パターンを1つ消したときに落ちるテストが1本に特定できるよう、まとめずに test() を分ける
// （まとめると *secret* だけ消しても他ケースが落として原因が絞れない）。
//
// fixture は必ず**片方の形だけに当たる**ように選ぶ。両形に当たるパスを使うと、
// 一方のパターンを消しても緑のままになり「片落ち」を検出できない。
//   例: config/secrets/api-keys.yml の基底名は secret を含まない → **/secrets/** だけが拾う
const RISK_PATTERN_CASES = [
  // [テスト名, 変更するパス, 守っているパターン]
  ['Vault 変数ファイル（基底名形）', 'ansible/group_vars/all/vault.yml.example', '*vault*'],
  ['Vault ディレクトリ配下（ディレクトリ形）', 'vault/prod.yml', '**/vault/**'],
  ['シークレット定義（基底名形）', 'config/client_secret.json', '*secret*'],
  ['secrets ディレクトリ配下（ディレクトリ形）', 'config/secrets/api-keys.yml', '**/secrets/**'],
  ['認証情報（基底名形）', 'infra/aws-credentials.json', '*credential*'],
  ['credentials ディレクトリ配下（ディレクトリ形）', 'credentials/gcp.json', '**/credentials/**'],
  ['ルート直下の nginx 設定（基底名形）', 'nginx.conf', '*nginx*'],
  ['role 配下の nginx テンプレート（ディレクトリ形）', 'ansible/roles/nginx/templates/10-app.conf.j2', '**/nginx/**'],
  ['terraform 定義', 'infra/main.tf', '*.tf'],
  ['terraform 変数', 'infra/prod.tfvars', '*.tfvars'],
];

for (const [label, rel, pattern] of RISK_PATTERN_CASES) {
  test(`AC27: ${label}は小さくても HIGH（${pattern}）`, (t) => {
    const { dir, base } = newBaseRepo(t);
    writeLines(dir, rel, 10);
    const head = commit(dir, 'change');

    const out = parseJsonOutput(runScript(['--dir', dir, '--base', base, '--head', head]));

    assert.equal(out.size, 'S', 'サイズ軸が影響を受けている');
    assert.equal(out.risk, 'HIGH', `${rel} が LOW に倒れている（${pattern} の欠落・片落ち疑い）`);
    // 「たまたま別のパターンに当たって HIGH になった」を排除するため一致パスまで固定する。
    assert.deepEqual(out.matched_risk_paths, [rel]);
  });
}

// Ansible playbook 一式（**/ansible/**）まで広げると infra リポでは risk がほぼ定数になり、
// 「小さい変更が常に重い」を再生産する（実測: 同じ infra リポジトリの HIGH 率 5% → 67%）。
// 既定は秘密・境界に限定し、IaC 全体を重く見たいリポは conf の risk: で足す側に倒す。
// この線引き自体が仕様なので、広げていないことを回帰テストで固定する。
test('AC27: 秘密・境界に当たらない Ansible playbook は LOW のまま（既定を広げすぎない）', (t) => {
  const { dir, base } = newBaseRepo(t);
  writeLines(dir, 'ansible/roles/gh_runner/tasks/main.yml', 30);
  const head = commit(dir, 'change');

  const out = parseJsonOutput(runScript(['--dir', dir, '--base', base, '--head', head]));

  assert.equal(out.risk, 'LOW', '既定パターンが IaC 全体へ広がっている');
  assert.deepEqual(out.matched_risk_paths, []);
});

test('AC27: IaC 全体を重く見たいリポは conf の risk: で足せる（強化方向は無音）', (t) => {
  const { dir, base } = newBaseRepo(t);
  writeText(dir, '.agent/size-tier.conf', 'risk:**/ansible/**\n');
  writeLines(dir, 'ansible/roles/gh_runner/tasks/main.yml', 30);
  const head = commit(dir, 'change');

  const out = parseJsonOutput(runScript(['--dir', dir, '--base', base, '--head', head]));

  assert.equal(out.risk, 'HIGH');
  assert.deepEqual(out.matched_risk_paths, ['ansible/roles/gh_runner/tasks/main.yml']);
  assert.deepEqual(out.warnings, [], '強化方向の上書きで warnings が鳴っている（オオカミ少年化）');
});

// --- AC28 / AC29: 転記ドリフト防止（Issue #34 Phase 3+4 のセルフレビュー由来）-----
//
// 上の SELF_REVIEW_S / SELF_REVIEW_ML はスクリプト側の配列を JS 側に「転記」したもので、
// 両方を同時に書き換えれば deep equal は通ってしまう（ミラーなので意味を守れない）。
// 以下の2本は転記ではなく「守りたい性質そのもの」を assert する。

test('AC28: サイズ S でもバグ・コード品質を見る agent が必ず1本は起動する', (t) => {
  const { dir, base } = newBaseRepo(t);
  writeLines(dir, 'src/plain.ts', 50); // S 判定になる行数
  const head = commit(dir, 'change');

  const out = parseJsonOutput(runScript(['--dir', dir, '--base', base, '--head', head]));

  assert.equal(out.size, 'S');
  assert.ok(
    out.gates.self_review_members.includes('dev-flow:Code-Reviewer'),
    'S の self_review_members から Code-Reviewer が消えている。' +
      'S では dev-implement Step 3 の Code-Reviewer が ship に集約される（code_reviewer="ship"）ため、' +
      'ここに居ないとバグ・入力検証を見る agent が dev-flow 全体から消える。' +
      'simplify-reviewer は禁止事項で「バグ・セキュリティの指摘」を除外しているので代替にならない',
  );
  assert.equal(out.gates.code_reviewer, 'ship', 'S で code_reviewer が ship でなくなったら AC28 の前提が変わる');
});

test('AC29: dev-ship E1.5c のテスト台帳が依存する coverage-checker はサイズによらず残る', (t) => {
  const { dir, base } = newBaseRepo(t);

  for (const [n, expected] of [[50, 'S'], [200, 'M'], [700, 'L']]) {
    writeLines(dir, 'src/plain.ts', n);
    const head = commit(dir, `change-${n}`);
    const out = parseJsonOutput(runScript(['--dir', dir, '--base', base, '--head', head]));

    assert.equal(out.size, expected);
    assert.ok(
      out.gates.self_review_members.includes('dev-flow:requirement-coverage-checker'),
      `${expected} で requirement-coverage-checker が落ちている。dev-ship E1.5c の台帳が coverage.md を入力にするため壊れる`,
    );
  }
});

// --- AC30〜AC34: スコープ軸と gates.qa（契約 §5.5・改訂4）---------------------
//
// dev-qa は差分レビュー（self-review / security-review / test-ledger）が原理的に見られない
// 「本来あるべきなのに追加コミットが無いファイル」を拾う唯一の catch layer
// （memory feedback_diff_review_blindspot）。Phase 1〜4 で差分レビューを軽くした分、
// リスク HIGH かつ frontend + backend 両スコープの案件では qa のスキップを禁止する。

test('AC30: frontend + backend 両スコープ × リスク HIGH で qa が required になる', (t) => {
  const { dir, base } = newBaseRepo(t);
  writeLines(dir, 'frontend/components/UserList.tsx', 30); // frontend の陽性証拠
  writeLines(dir, 'backend/api/users.py', 30); // backend の陽性証拠 かつ **/api/** で HIGH
  const head = commit(dir, 'change');

  const out = parseJsonOutput(runScript(['--dir', dir, '--base', base, '--head', head]));

  assert.equal(out.risk, 'HIGH');
  assert.deepEqual(
    out.scopes,
    ['frontend', 'backend'],
    'scopes の並びは ["frontend","backend"] に固定する（契約 §2）',
  );
  // qa 単独の assert ではなく gates 丸ごとの deep equal にする。required の経路で
  // 他のキーが巻き添えで変わる変異を拾うため（契約 §9 が AC1 に「6通りを deep equal で
  // 丸ごと」と書いた意図。required 側は AC33 のフォールバックにしか deep equal が無かった）。
  assert.deepEqual(
    out.gates,
    {
      adversarial_lenses: ['A', 'D'],
      code_reviewer: 'ship',
      self_review_members: SELF_REVIEW_S,
      security_review: true,
      test_ledger: 'skip',
      explain_diff: 'post_pr',
      qa: 'required',
    },
    'frontend + backend 両スコープ × HIGH で qa が required になっていない。' +
      'dev-ship E0.7 がこの値でしか止まらないので、ここが optional だと' +
      '差分レビューを軽くした経路に catch layer が1つも残らない',
  );
});

test('AC31: リスク HIGH でも片スコープなら optional / 分類不能だけなら scopes は空', (t) => {
  const single = newBaseRepo(t);
  // backend の陽性証拠のみ（frontend は無い）。**/api/** なのでリスクは HIGH。
  writeLines(single.dir, 'backend/api/users.py', 30);
  const singleHead = commit(single.dir, 'backend only');

  const outSingle = parseJsonOutput(
    runScript(['--dir', single.dir, '--base', single.base, '--head', singleHead]),
  );

  assert.equal(outSingle.risk, 'HIGH');
  assert.deepEqual(outSingle.scopes, ['backend']);
  assert.equal(outSingle.gates.qa, 'optional', '片スコープで qa が required になっている（過剰発火）');

  // 分類不能（.ts / .md / .sh）だけの変更。「不明なら fail-safe に両方」としてしまうと
  // リスク HIGH のほぼ全変更が required になり、Issue #34 の動機を再生産する（契約 §5.5）。
  //
  // リスク HIGH の作り方に Dockerfile を使う。**/api/** のようなディレクトリ形の
  // リスクパターンは backend スコープの陽性証拠でもあるため（意図どおり）、
  // ここで使うと「分類不能だけ」の条件を作れない。
  const unknown = newBaseRepo(t);
  writeLines(unknown.dir, 'Dockerfile', 30); // HIGH。スコープはどちらにも当たらない
  writeLines(unknown.dir, 'src/handler.ts', 30);
  writeLines(unknown.dir, 'docs/notes.md', 10);
  writeLines(unknown.dir, 'scripts/run.sh', 10);
  const unknownHead = commit(unknown.dir, 'unclassifiable only');

  const outUnknown = parseJsonOutput(
    runScript(['--dir', unknown.dir, '--base', unknown.base, '--head', unknownHead]),
  );

  assert.equal(outUnknown.risk, 'HIGH');
  assert.deepEqual(
    outUnknown.scopes,
    [],
    '分類不能ファイルがスコープに数えられている（.ts をどちらかに寄せていないか）',
  );
  assert.equal(outUnknown.gates.qa, 'optional');
});

// ⚠ このテストは**スコープ軸とリスク軸の独立性を守っている唯一のケース**。
// 他の required 系 fixture はリスク HIGH の出所が `**/api/**`（＝ backend スコープの
// パターンでもある）なので、backend スコープをリスク一致に従属させる変異を撃墜できるのは
// ここだけ（敵対的検証で実測）。削るときはリスク軸と無関係な両スコープ fixture を先に用意すること。
test('AC32: 両スコープでもリスク LOW なら optional（スコープ軸だけでは発火しない）', (t) => {
  const { dir, base } = newBaseRepo(t);
  writeLines(dir, 'frontend/components/Card.tsx', 20);
  // backend の陽性証拠だが、リスクパターンには当たらないパス（**/api/** 等を避ける）。
  writeLines(dir, 'backend/usecase/calc.py', 20);
  const head = commit(dir, 'change');

  const out = parseJsonOutput(runScript(['--dir', dir, '--base', base, '--head', head]));

  assert.equal(out.risk, 'LOW', 'fixture がリスク LOW になっていない（パスを見直すこと）');
  assert.deepEqual(out.scopes, ['frontend', 'backend']);
  assert.equal(out.gates.qa, 'optional', 'リスク LOW なのに qa が required になっている');
});

test('AC33: フォールバックでも qa は required・scopes は空', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assess-size-notgit-qa-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const out = parseJsonOutput(runScript(['--dir', dir]));

  assert.equal(out.fallback, true);
  assert.deepEqual(out.scopes, []);
  assert.equal(out.gates.qa, 'required');
});

test('AC34: exclude はスコープ判定に効かない（conf 1行で qa ゲートが無音で死なない）', (t) => {
  const { dir, base } = newBaseRepo(t);
  // frontend の陽性証拠を除外パターンで消そうとする。契約 §5.5: スコープ照合は
  // 除外を適用しないので、サイズからは落ちても scopes からは消えない。
  writeText(dir, '.agent/size-tier.conf', 'exclude: **/*.tsx\n');
  writeLines(dir, 'frontend/components/UserList.tsx', 30);
  writeLines(dir, 'backend/api/users.py', 30);
  const head = commit(dir, 'change');

  const out = parseJsonOutput(runScript(['--dir', dir, '--base', base, '--head', head]));

  assert.deepEqual(
    out.excluded_paths,
    ['frontend/components/UserList.tsx'],
    'fixture の前提が崩れている: exclude がサイズ集計に効いていない',
  );
  assert.deepEqual(
    out.scopes,
    ['frontend', 'backend'],
    'exclude がスコープ判定に効いてしまっている。conf に1行足すだけで qa ゲートが無音で消える',
  );
  assert.equal(out.gates.qa, 'required');
});

test('AC34: frontend_reset / backend_reset は緩和方向なので warnings で音を立てる', (t) => {
  const { dir, base } = newBaseRepo(t);
  writeText(dir, '.agent/size-tier.conf', 'frontend_reset\n');
  writeLines(dir, 'frontend/components/UserList.tsx', 30);
  writeLines(dir, 'backend/api/users.py', 30);
  const head = commit(dir, 'change');

  const out = parseJsonOutput(runScript(['--dir', dir, '--base', base, '--head', head]));

  // 既定の frontend パターンが捨てられるので両スコープが成立せず required が消える。
  assert.deepEqual(out.scopes, ['backend']);
  assert.equal(out.gates.qa, 'optional');
  assert.ok(
    out.warnings.some((w) => w.includes('.agent/size-tier.conf') && w.includes('frontend_reset')),
    'frontend_reset で警告が出ていない（ゲートが無音で軽くなる）',
  );
});

// --- AC37: 既定スコープパターンを1本ずつ固定する（表駆動）----------------------
//
// AC30〜AC36 が固定しているのは「非採用判断」（何を入れなかったか）だけで、
// **採用したパターンはほぼ固定されていなかった**。敵対的検証の実測では、
// 既定スコープパターン35本のうち33本は個別に削除しても全テストが pass し、
// 31本を同時に削除しても pass した（`*.vue` `*.svelte` `**/views/**` `*.go` `*.rs`
// `**/repositories/**` の6本を削って 74 pass / 0 fail を再現済み）。
// パターン表は実 PR 72件のキャリブレーションで据え置きを決めた成果物そのものなので、
// 「整理」で数本消えても無音（しかも落ちる方向は qa=optional ＝軽い側）なのは
// Issue #34 の全指摘が収束した failure mode と同型。
//
// 下の表は**スクリプトの配列を転記したミラーではない**。スクリプトから配列を実際に
// パースしてキー集合を突き合わせるので、パターンを足しても消してもテストが落ちる。

// `NAME=(` から `)` までの行を読み、コメントを除いた "..." を取り出す。
function parsePatternArray(name) {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const start = src.indexOf(`${name}=(\n`);
  assert.ok(start >= 0, `${name} をスクリプトから読み取れなかった`);
  const body = src.slice(start + `${name}=(\n`.length);
  const end = body.indexOf('\n)');
  assert.ok(end >= 0, `${name} の閉じ括弧が見つからない`);
  return body
    .slice(0, end)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const m = /^"(.*)"$/.exec(l);
      assert.ok(m, `${name} に解釈できない行がある: ${l}`);
      return m[1];
    });
}

// パターン → そのパターン**だけ**に一致する代表パス。
// 接頭辞 zzf / zzb と拡張子 .q はどのパターンにも一致しない中立な値。
const FRONTEND_CASES = {
  '*.tsx': 'zzf/a.tsx',
  '*.jsx': 'zzf/a.jsx',
  '*.vue': 'zzf/a.vue',
  '*.svelte': 'zzf/a.svelte',
  '*.css': 'zzf/a.css',
  '*.scss': 'zzf/a.scss',
  '*.sass': 'zzf/a.sass',
  '*.less': 'zzf/a.less',
  '*.html': 'zzf/a.html',
  '**/components/**': 'zzf/components/a.q',
  '**/pages/**': 'zzf/pages/a.q',
  '**/views/**': 'zzf/views/a.q',
  '**/layouts/**': 'zzf/layouts/a.q',
  '**/public/**': 'zzf/public/a.q',
  '**/assets/**': 'zzf/assets/a.q',
  '**/styles/**': 'zzf/styles/a.q',
  '**/frontend/**': 'zzf/frontend/a.q',
  '**/client/**': 'zzf/client/a.q',
};
const BACKEND_CASES = {
  '**/api/**': 'zzb/api/a.q',
  '**/routes/**': 'zzb/routes/a.q',
  '**/controllers/**': 'zzb/controllers/a.q',
  '**/models/**': 'zzb/models/a.q',
  '**/migrations/**': 'zzb/migrations/a.q',
  '**/schema*': 'zzb/schema_a.q',
  '**/backend/**': 'zzb/backend/a.q',
  '**/server/**': 'zzb/server/a.q',
  '**/repositories/**': 'zzb/repositories/a.q',
  '**/db/**': 'zzb/db/a.q',
  '*.py': 'zzb/a.py',
  '*.rb': 'zzb/a.rb',
  '*.go': 'zzb/a.go',
  '*.php': 'zzb/a.php',
  '*.java': 'zzb/a.java',
  '*.cs': 'zzb/a.cs',
  '*.rs': 'zzb/a.rs',
};
// 反対側の証拠。いずれも1パターンにしか一致しない（多重一致だと個別パターンの
// 欠落を打ち消してしまう）。
const FRONTEND_COUNTERPART = 'zzf/counterpart.html'; // *.html のみ
const BACKEND_COUNTERPART = 'zzb/api/counterpart.q'; // **/api/** のみ

test('AC37: 既定スコープパターン35本を1本ずつ固定する（表駆動・スクリプトから実パース）', (t) => {
  const frontendPatterns = parsePatternArray('DEFAULT_FRONTEND_PATTERNS');
  const backendPatterns = parsePatternArray('DEFAULT_BACKEND_PATTERNS');

  // 表がスクリプトと1対1であることを先に固定する。パターンを足したのにケースを
  // 足さなければここで落ちる（テスト側の表がミラーではなく契約になる）。
  assert.deepEqual(
    [...frontendPatterns].sort(),
    Object.keys(FRONTEND_CASES).sort(),
    'DEFAULT_FRONTEND_PATTERNS と FRONTEND_CASES がズレている。パターンを増減したら代表パスも増減させること',
  );
  assert.deepEqual(
    [...backendPatterns].sort(),
    Object.keys(BACKEND_CASES).sort(),
    'DEFAULT_BACKEND_PATTERNS と BACKEND_CASES がズレている。パターンを増減したら代表パスも増減させること',
  );

  // 1つの repo に全ケースのコミットを積み、--base <直前> --head <当該> で
  // 1ケース分の差分だけを判定させる（repo を35個作ると遅いため）。
  const dir = initRepo(t, { branch: 'main' });
  const allPaths = [
    ...Object.values(FRONTEND_CASES),
    ...Object.values(BACKEND_CASES),
    FRONTEND_COUNTERPART,
    BACKEND_COUNTERPART,
  ];
  for (const p of allPaths) writeText(dir, p, '');
  let prev = commit(dir, 'base');

  const cases = [
    ...Object.entries(FRONTEND_CASES).map(([pat, p]) => ({ pat, p, counterpart: BACKEND_COUNTERPART })),
    ...Object.entries(BACKEND_CASES).map(([pat, p]) => ({ pat, p, counterpart: FRONTEND_COUNTERPART })),
  ];

  cases.forEach(({ pat, p, counterpart }, i) => {
    writeLines(dir, p, 10 + i);
    writeLines(dir, counterpart, 10 + i);
    const head = commit(dir, `case ${pat}`);

    const out = parseJsonOutput(runScript(['--dir', dir, '--base', prev, '--head', head]));
    prev = head;

    assert.deepEqual(
      out.scopes,
      ['frontend', 'backend'],
      `パターン ${pat}（代表パス ${p}）が効いていない。` +
        'このパターンを既定から消しても他のテストは通ってしまうので、ここが唯一の番人',
    );
  });
});

test('AC35: スコープ照合はケース非依存（契約 §5.5 は §5 と同一の照合規則を要求している）', (t) => {
  const { dir, base } = newBaseRepo(t);
  // .NET / Java 系の命名を模す。既定パターンは全て小文字なので、ケース依存の照合だと
  // どちらも分類できず scopes:[] に落ちる（＝ qa が無音で optional になる）。
  writeLines(dir, 'SRC/COMPONENTS/Card.TSX', 20);
  writeLines(dir, 'BACKEND/API/Users.PY', 20);
  const head = commit(dir, 'change');

  const out = parseJsonOutput(runScript(['--dir', dir, '--base', base, '--head', head]));

  assert.equal(out.risk, 'HIGH', 'リスク照合のケース非依存（AC20）が壊れている');
  assert.deepEqual(
    out.scopes,
    ['frontend', 'backend'],
    'スコープ照合がケース依存になっている。契約 §5.5 は §5 と同一の照合規則（ケース非依存）を' +
      '要求しており、ケース依存だと大文字命名のリポで両スコープが成立せず qa が無音で optional に落ちる',
  );
  assert.equal(out.gates.qa, 'required');
});

// パターン境界。AC30 の fixture（frontend/components/UserList.tsx）は *.tsx と **/frontend/**
// と **/components/** に同時一致するため、個別パターンの削除・誤変更を検出できない。
// 以下は契約 §5.5「入れなかったパターンと理由」の3判断を1つずつ狙い撃つ。
test('AC36: templates は HTML なら frontend・設定テンプレート(.j2)なら非分類', (t) => {
  // Django / Flask の HTML テンプレートは *.html で **意図的に** frontend として立つ
  // （表示層そのものなので、API と同じ PR にあるなら dev-qa が見るべき cross-stack 変更）。
  const html = newBaseRepo(t);
  writeLines(html.dir, 'app/templates/login.html', 20);
  writeLines(html.dir, 'backend/api/users.py', 20);
  const htmlHead = commit(html.dir, 'django template + api');

  const outHtml = parseJsonOutput(
    runScript(['--dir', html.dir, '--base', html.base, '--head', htmlHead]),
  );
  assert.deepEqual(
    outHtml.scopes,
    ['frontend', 'backend'],
    'templates/*.html が frontend として立っていない。*.html を既定から外すと Django/Flask の' +
      '表示層変更が qa の対象から無音で外れる',
  );
  assert.equal(outHtml.gates.qa, 'required');

  // infra リポの設定テンプレート（.j2）は frontend にしない。ここが frontend になると
  // nginx（リスク HIGH）と組み合わさって qa=required がほぼ定数になる。
  const j2 = newBaseRepo(t);
  writeLines(j2.dir, 'roles/nginx/templates/10-app.conf.j2', 20);
  writeLines(j2.dir, 'backend/api/users.py', 20);
  const j2Head = commit(j2.dir, 'ansible template + api');

  const outJ2 = parseJsonOutput(runScript(['--dir', j2.dir, '--base', j2.base, '--head', j2Head]));
  assert.deepEqual(
    outJ2.scopes,
    ['backend'],
    '設定テンプレート(.j2)が frontend として立っている。infra リポで qa=required が定数化する',
  );
  assert.equal(outJ2.gates.qa, 'optional');
});

test('AC36: services/*.ts と素の *.ts は backend の陽性証拠にしない（既知の偽陰性）', (t) => {
  const { dir, base } = newBaseRepo(t);
  // src/services/ はフロントの API クライアント置き場としても一般的なので backend にしない。
  // 結果として Node / Nest / Express の backend は陽性証拠が取れず qa が optional になる
  // （契約 §5.5 に明記した既知の穴。既定を広げると SPA 側で過剰発火する）。
  writeLines(dir, 'src/components/Card.tsx', 20);
  writeLines(dir, 'src/services/userApi.ts', 20);
  writeLines(dir, 'src/api/handler.ts', 20); // **/api/** なのでリスクは HIGH になる
  const head = commit(dir, 'change');

  const out = parseJsonOutput(runScript(['--dir', dir, '--base', base, '--head', head]));

  assert.equal(out.risk, 'HIGH');
  assert.deepEqual(
    out.scopes,
    ['frontend', 'backend'],
    'src/api/handler.ts は **/api/** で backend の陽性証拠になる（ディレクトリ形パターンは' +
      '拡張子に依存しない）。ここが変わったら契約 §5.5 の帰結が変わっている',
  );

  // services/*.ts だけでは backend が立たないことを単独で固定する。
  const svc = newBaseRepo(t);
  writeLines(svc.dir, 'src/components/Card.tsx', 20);
  writeLines(svc.dir, 'src/services/userApi.ts', 20);
  writeLines(svc.dir, 'src/usecases/calc.ts', 20);
  const svcHead = commit(svc.dir, 'frontend + ts services only');

  const outSvc = parseJsonOutput(
    runScript(['--dir', svc.dir, '--base', svc.base, '--head', svcHead]),
  );
  assert.deepEqual(
    outSvc.scopes,
    ['frontend'],
    '**/services/** か *.ts が backend の陽性証拠になっている。SPA 単体リポが両スコープになり' +
      'qa=required が過剰発火する（契約 §5.5 の非採用判断が崩れている）',
  );
  assert.equal(outSvc.gates.qa, 'optional');
});

test('AC34: conf の frontend: 追加は強化方向なので無音（オオカミ少年化を避ける）', (t) => {
  const { dir, base } = newBaseRepo(t);
  writeText(dir, '.agent/size-tier.conf', 'frontend: src/ui/**\n');
  writeLines(dir, 'src/ui/panel.ts', 20); // 既定では分類不能だが conf で frontend になる
  writeLines(dir, 'backend/api/users.py', 20);
  const head = commit(dir, 'change');

  const out = parseJsonOutput(runScript(['--dir', dir, '--base', base, '--head', head]));

  assert.deepEqual(out.scopes, ['frontend', 'backend']);
  assert.equal(out.gates.qa, 'required');
  assert.deepEqual(out.warnings, [], '強化方向の上書きで warnings が鳴っている（オオカミ少年化）');
});

// --- AC38: conf の backend 側（契約 §3.1 / §8 は frontend と backend を対称に規定している）---
// 敵対的検証の実測では、backend 側は `backend_reset` の case 節・逸脱警告・reset 適用・
// `backend:` の case 節を**どれ1つ削っても全テストが pass**した（frontend 側だけ AC34 が
// 守っていた）。対称な仕様に非対称なテストしか無い状態を塞ぐ。

test('AC38: backend_reset は既定を捨て、緩和方向なので warnings で音を立てる', (t) => {
  const { dir, base } = newBaseRepo(t);
  writeText(dir, '.agent/size-tier.conf', 'backend_reset\n');
  writeLines(dir, 'frontend/components/UserList.tsx', 20);
  writeLines(dir, 'backend/api/users.py', 20);
  const head = commit(dir, 'change');

  const out = parseJsonOutput(runScript(['--dir', dir, '--base', base, '--head', head]));

  assert.deepEqual(
    out.scopes,
    ['frontend'],
    'backend_reset が効いていない（既定の **/backend/** / **/api/** / *.py が残っている）',
  );
  assert.equal(out.gates.qa, 'optional');
  assert.ok(
    out.warnings.some((w) => w.includes('.agent/size-tier.conf') && w.includes('backend_reset')),
    'backend_reset で警告が出ていない（frontend_reset と非対称になっている）',
  );
});

test('AC38: conf の backend: 追加は強化方向なので無音', (t) => {
  const { dir, base } = newBaseRepo(t);
  writeText(dir, '.agent/size-tier.conf', 'backend: src/domain/**\n');
  writeLines(dir, 'src/components/Card.tsx', 20);
  writeLines(dir, 'src/domain/order.q', 20); // 既定では分類不能だが conf で backend になる
  const head = commit(dir, 'change');

  const out = parseJsonOutput(runScript(['--dir', dir, '--base', base, '--head', head]));

  assert.deepEqual(out.scopes, ['frontend', 'backend'], 'conf の backend: が効いていない');
  assert.deepEqual(out.warnings, [], '強化方向の上書きで warnings が鳴っている');
});

test('AC38: *_reset と *: の併用は「既定を捨てて追加分だけ残す」（順序依存の semantics）', (t) => {
  const { dir, base } = newBaseRepo(t);
  // reset は「読み込み後に既定を落とす」＝ 追加分だけが残る（契約 §8）。
  // 単独 reset のテスト（AC34 / AC38）は add が空なので、実装を `=(default add)` に
  // 単純化する「整理」が入っても結果が変わらず気づけない。併用で semantics を固定する。
  writeText(dir, '.agent/size-tier.conf', ['frontend_reset', 'frontend: src/ui/**', ''].join('\n'));
  writeLines(dir, 'src/ui/panel.q', 20); // 追加分でだけ frontend になる
  writeLines(dir, 'src/components/Card.tsx', 20); // 既定の frontend パターン（捨てられるはず）
  writeLines(dir, 'backend/api/users.py', 20);
  const head = commit(dir, 'change');

  const out = parseJsonOutput(runScript(['--dir', dir, '--base', base, '--head', head]));

  assert.deepEqual(
    out.scopes,
    ['frontend', 'backend'],
    'frontend_reset + frontend: の併用で追加分が消えている（reset が add を巻き添えにしている）',
  );

  // 追加分を消すと frontend が立たなくなることまで確認する（＝上の結果が既定パターンの
  // 生き残りによるものではないことの証明）。
  const resetOnly = newBaseRepo(t);
  writeText(resetOnly.dir, '.agent/size-tier.conf', 'frontend_reset\n');
  writeLines(resetOnly.dir, 'src/ui/panel.q', 20);
  writeLines(resetOnly.dir, 'src/components/Card.tsx', 20);
  writeLines(resetOnly.dir, 'backend/api/users.py', 20);
  const resetHead = commit(resetOnly.dir, 'reset only');

  const outResetOnly = parseJsonOutput(
    runScript(['--dir', resetOnly.dir, '--base', resetOnly.base, '--head', resetHead]),
  );
  assert.deepEqual(
    outResetOnly.scopes,
    ['backend'],
    'frontend_reset だけで既定が捨てられていない',
  );

  // backend 側も対称に固定する。片側だけ併用テストがある状態は、この AC が塞いだ
  // 「対称な仕様に非対称なテスト」を別の形で残すことになる。
  const back = newBaseRepo(t);
  writeText(back.dir, '.agent/size-tier.conf', ['backend_reset', 'backend: src/domain/**', ''].join('\n'));
  writeLines(back.dir, 'src/domain/order.q', 20); // 追加分でだけ backend になる
  writeLines(back.dir, 'backend/api/users.py', 20); // 既定の backend パターン（捨てられるはず）
  writeLines(back.dir, 'frontend/components/Card.tsx', 20);
  const backHead = commit(back.dir, 'backend reset + add');

  const outBack = parseJsonOutput(
    runScript(['--dir', back.dir, '--base', back.base, '--head', backHead]),
  );
  assert.deepEqual(
    outBack.scopes,
    ['frontend', 'backend'],
    'backend_reset + backend: の併用で追加分が消えている（reset が add を巻き添えにしている）',
  );
});

test('AC38: 値が空の frontend: / backend: 行は拒否し、行番号だけを warnings に出す', (t) => {
  const { dir, base } = newBaseRepo(t);
  // 契約 §8 の「値が空の risk: / exclude: 行は拒否し warnings に追記」は
  // frontend: / backend: にも同じ作法で効く（改訂4）。実害は警告の消失だけだが、
  // 「conf を書き間違えていることに気づけない」は §3.1 の fail-loud の一部。
  writeText(dir, '.agent/size-tier.conf', ['frontend:', 'backend:   ', ''].join('\n'));
  writeLines(dir, 'frontend/components/UserList.tsx', 20);
  writeLines(dir, 'backend/api/users.py', 20);
  const head = commit(dir, 'change');

  const out = parseJsonOutput(runScript(['--dir', dir, '--base', base, '--head', head]));

  const lineWarnings = out.warnings.filter((w) => /size-tier\.conf の \d+ 行目を解釈できなかった/.test(w));
  assert.equal(lineWarnings.length, 2, '空値の frontend: / backend: が無音で捨てられている');
  // 行の中身は載せない（§3.1: conf の内容は秘密の漏洩と後続への指示注入の経路になる）。
  assert.ok(
    !out.warnings.some((w) => w.includes('frontend:') || w.includes('backend:')),
    'warnings に conf の行の中身が載っている',
  );
  // 既定は生きているので判定自体は変わらない。
  assert.deepEqual(out.scopes, ['frontend', 'backend']);
});

// --- AC39〜AC42: テンプレートがあるのに conf が無い状態を fail-loud にする（Issue #44 問題1）---
//
// .agent/ は全面 gitignore で、dev-flow は Issue ごとに新しい worktree を切る運用（業務リポジトリでは
// 16本稼働していた）。その結果、プロジェクト固有の較正である .agent/size-tier.conf は
// **新しい worktree では黙って存在せず既定値に戻る**。警告も出ないため誰も気づけない。
//
// dev-setup 側の手順（B1-3.5 でテンプレートをコピー）だけでは、既に稼働中の worktree にも
// dev-setup を経由しない worktree 運用（cc-plugins 自身の .claude/worktrees/）にも効かない。
// 判定器が「テンプレートがあるのに conf が無い」を検出して音を立てるのが、
// その両方に効く唯一の対策。
//
// テンプレートは tracked な場所に置く（.agent/ に置いたら同じ理由で消えるため）。
const CONF_TEMPLATE = 'docs/testing/size-tier.conf.template';

test('AC39: テンプレートがあるのに .agent/size-tier.conf が無ければ warnings に出る', (t) => {
  const { dir, base } = newBaseRepo(t);
  writeText(dir, CONF_TEMPLATE, ['# プロジェクト固有の較正', 'threshold_m=50', ''].join('\n'));
  writeLines(dir, 'src/app.js', 10);
  const head = commit(dir, 'change');

  const out = parseJsonOutput(runScript(['--dir', dir, '--base', base, '--head', head]));
  assert.ok(
    out.warnings.some((w) => w.includes(CONF_TEMPLATE)),
    `テンプレート未適用の warning が無い: ${JSON.stringify(out.warnings)}`,
  );
  // 判定自体は既定値で続行する（中断はしない）。音を立てるだけ。
  assert.equal(out.size, 'S', 'テンプレート未適用時は既定値で判定を続けるべき');
  assert.equal(out.fallback, false, 'これは fallback ではない（判定は成立している）');
});

test('AC40: conf が実在すればテンプレートがあっても warning を出さない', (t) => {
  const { dir, base } = newBaseRepo(t);
  writeText(dir, CONF_TEMPLATE, ['threshold_m=50', ''].join('\n'));
  writeText(dir, '.agent/size-tier.conf', ['threshold_m=50', ''].join('\n'));
  writeLines(dir, 'src/app.js', 10);
  const head = commit(dir, 'change');

  const out = parseJsonOutput(runScript(['--dir', dir, '--base', base, '--head', head]));
  assert.ok(
    !out.warnings.some((w) => w.includes(CONF_TEMPLATE)),
    `conf があるのにテンプレート警告が出ている: ${JSON.stringify(out.warnings)}`,
  );
});

test('AC41: テンプレートが無いリポでは何も起きない（no-op）', (t) => {
  const { dir, base } = newBaseRepo(t);
  writeLines(dir, 'src/app.js', 10);
  const head = commit(dir, 'change');

  const out = parseJsonOutput(runScript(['--dir', dir, '--base', base, '--head', head]));
  assert.deepStrictEqual(
    out.warnings, [],
    `テンプレートも conf も無いリポで warning が出ている: ${JSON.stringify(out.warnings)}`,
  );
});

test('AC42: conf が読めない場合（symlink 拒否）もテンプレート警告の対象になる', (t) => {
  const { dir, base } = newBaseRepo(t);
  writeText(dir, CONF_TEMPLATE, ['threshold_m=50', ''].join('\n'));
  // conf を symlink にすると load_conf は読み込みを拒否する（既存仕様）。
  // 「ファイルはあるが較正は効いていない」状態なので、テンプレート警告も鳴るべき。
  // ここを「存在チェック」だけで実装すると、この状態が無音で既定値に戻る。
  fs.mkdirSync(path.join(dir, '.agent'), { recursive: true });
  writeText(dir, 'real-conf.txt', 'threshold_m=50\n');
  fs.symlinkSync(path.join(dir, 'real-conf.txt'), path.join(dir, '.agent', 'size-tier.conf'));
  writeLines(dir, 'src/app.js', 10);
  const head = commit(dir, 'change');

  const out = parseJsonOutput(runScript(['--dir', dir, '--base', base, '--head', head]));
  assert.ok(
    out.warnings.some((w) => w.includes('シンボリックリンク')),
    `symlink 拒否の既存 warning が消えている: ${JSON.stringify(out.warnings)}`,
  );
  assert.ok(
    out.warnings.some((w) => w.includes(CONF_TEMPLATE)),
    `較正が効いていないのにテンプレート警告が無い: ${JSON.stringify(out.warnings)}`,
  );
});

test('AC43: .agent ディレクトリ自体が symlink でも conf は読める（dev-setup B6-0 と両立）', (t) => {
  const { dir, base } = newBaseRepo(t);
  // dev-setup B6-0 は project folder に `.agent -> worktrees/<branch>/.agent` を張る。
  // load_conf の symlink 拒否は `-L "$conf"` で**最終要素だけ**を見るため、
  // .agent がディレクトリ symlink でも conf 自体は通常ファイルとして読める。
  // この両立が壊れると B6-0 の運用下で全リポの較正が無音で死ぬ。
  const realAgent = path.join(dir, 'real-agent');
  fs.mkdirSync(realAgent, { recursive: true });
  fs.writeFileSync(path.join(realAgent, 'size-tier.conf'), 'threshold_m=50\n');
  fs.symlinkSync(realAgent, path.join(dir, '.agent'));
  writeLines(dir, 'src/app.js', 60);
  const head = commit(dir, 'change');

  const out = parseJsonOutput(runScript(['--dir', dir, '--base', base, '--head', head]));
  assert.equal(out.size, 'M', '.agent が symlink のとき conf の threshold_m=50 が効いていない');
});

// --- AC44: 「コピーしただけの空 conf」を無音にしない（レンズ B M-1）--------------------
//
// テンプレート（*.template）は雛形なので**コメントだけ・空**で配布されるのが自然。
// dev-setup B1-3.5 がそれをそのまま cp すると conf ファイルは存在するので、
// 判定材料が「読み込めたか」だと **本機構の正規の運用フローがそのまま警告を無音にする**。
// 「ファイルはあるが中身が空」と「ファイルが無い」は較正が効いていない点で等価
// （判定結果も既定値で一致する）。両方とも鳴らす。
[
  { label: '空ファイル', body: '' },
  { label: 'コメントと空行のみ', body: '# threshold_m=50\n#\n\n   \n' },
].forEach(({ label, body }) => {
  test(`AC44: conf が${label}ならテンプレート警告が鳴る`, (t) => {
    const { dir, base } = newBaseRepo(t);
    writeText(dir, CONF_TEMPLATE, ['# 雛形', '# threshold_m=50', ''].join('\n'));
    writeText(dir, '.agent/size-tier.conf', body);
    writeLines(dir, 'src/app.js', 10);
    const head = commit(dir, 'change');

    const out = parseJsonOutput(runScript(['--dir', dir, '--base', base, '--head', head]));
    assert.ok(
      out.warnings.some((w) => w.includes('有効な設定が1行も無い')),
      `${label} の conf で警告が出ていない: ${JSON.stringify(out.warnings)}`,
    );
    // 「conf が無い」側の文面と取り違えていないこと。次にやることが違う
    // （無い→B1-3.5 でコピー / 空→中身を書く）。一律に B1-3.5 へ誘導すると、
    // 空のケースでは B1-3.5 が no-op なので戻ってきても何も起きないデッドエンドになる。
    assert.ok(
      !out.warnings.some((w) => w.includes('B1-3.5 のコピーが漏れている')),
      `conf が存在するのに「コピーが漏れている」と案内している: ${JSON.stringify(out.warnings)}`,
    );
  });
});

// conf_effective が 0 になる経路は5つ（不在 / symlink / ディレクトリ / 読取不可 / 64KB超）。
// AC42 は symlink しか固定しておらず、実測では「ディレクトリのときだけ無音化する」変異
// （`&& ! -d "$conf"` を足す）が 81/81 pass で素通りした。1経路でも漏れるとそこが
// 無音の抜け道になるので、残りの経路も塞ぐ。
test('AC42b: conf がディレクトリでもテンプレート警告の対象になる', (t) => {
  const { dir, base } = newBaseRepo(t);
  writeText(dir, CONF_TEMPLATE, ['threshold_m=50', ''].join('\n'));
  fs.mkdirSync(path.join(dir, '.agent', 'size-tier.conf'), { recursive: true });
  writeLines(dir, 'src/app.js', 10);
  const head = commit(dir, 'change');

  const out = parseJsonOutput(runScript(['--dir', dir, '--base', base, '--head', head]));
  assert.ok(
    out.warnings.some((w) => w.includes('ディレクトリ')),
    `ディレクトリ拒否の既存 warning が消えている: ${JSON.stringify(out.warnings)}`,
  );
  assert.ok(
    out.warnings.some((w) => w.includes(CONF_TEMPLATE)),
    `較正が効いていないのにテンプレート警告が無い: ${JSON.stringify(out.warnings)}`,
  );
});

test('AC42c: conf が読み取り不可でもテンプレート警告の対象になる', (t) => {
  const { dir, base } = newBaseRepo(t);
  writeText(dir, CONF_TEMPLATE, ['threshold_m=50', ''].join('\n'));
  writeText(dir, '.agent/size-tier.conf', 'threshold_m=50\n');
  writeLines(dir, 'src/app.js', 10);
  const head = commit(dir, 'change');
  // 権限を落とすのは commit の後。fixture の `git add -A` が読めなくなって失敗するため
  // （順序が仕様。先に落とすとテストの前提づくり自体が壊れる）。
  const confPath = path.join(dir, '.agent', 'size-tier.conf');
  fs.chmodSync(confPath, 0o000);
  t.after(() => {
    try { fs.chmodSync(confPath, 0o644); } catch { /* 既に削除済み */ }
  });

  const out = parseJsonOutput(runScript(['--dir', dir, '--base', base, '--head', head]));
  // root で実行すると chmod 000 でも読めてしまうため、その場合はスキップする
  // （読めた＝較正が効いているので警告が出ないのが正しい）。
  if (out.warnings.some((w) => w.includes('読み込めなかった'))) {
    assert.ok(
      out.warnings.some((w) => w.includes(CONF_TEMPLATE)),
      `較正が効いていないのにテンプレート警告が無い: ${JSON.stringify(out.warnings)}`,
    );
  }
});

test('AC45: conf に有効な設定が1行でもあればテンプレート警告は鳴らない', (t) => {
  const { dir, base } = newBaseRepo(t);
  writeText(dir, CONF_TEMPLATE, ['# 雛形', ''].join('\n'));
  writeText(dir, '.agent/size-tier.conf', ['# 説明', 'threshold_m=50', ''].join('\n'));
  writeLines(dir, 'src/app.js', 60);
  const head = commit(dir, 'change');

  const out = parseJsonOutput(runScript(['--dir', dir, '--base', base, '--head', head]));
  assert.ok(
    !out.warnings.some((w) => w.includes(CONF_TEMPLATE) || w.includes('有効な設定が1行も無い')),
    `較正が効いているのに警告が出ている: ${JSON.stringify(out.warnings)}`,
  );
  assert.equal(out.size, 'M', 'threshold_m=50 が適用されていない');
});

test('AC46: exclude 追加だけの conf も「適用されている」と数える', (t) => {
  const { dir, base } = newBaseRepo(t);
  writeText(dir, CONF_TEMPLATE, ['# 雛形', ''].join('\n'));
  // 閾値を変えず risk も足さず、exclude だけを書いた conf。較正としては有効なので
  // 警告は鳴らない。conf_applied の判定を threshold だけで書くとここが落ちる。
  writeText(dir, '.agent/size-tier.conf', ['exclude: **/generated/**', ''].join('\n'));
  writeLines(dir, 'src/app.js', 10);
  const head = commit(dir, 'change');

  const out = parseJsonOutput(runScript(['--dir', dir, '--base', base, '--head', head]));
  assert.ok(
    !out.warnings.some((w) => w.includes('有効な設定が1行も無い')),
    `exclude 追加が「適用されていない」と扱われている: ${JSON.stringify(out.warnings)}`,
  );
});

// --- AC47〜AC50（Issue #45 Phase 2 / 記法ドキュメント欠如の解消）--------------------
//
// 背景: .agent/size-tier.conf の記法を説明したドキュメントが存在せず、記法を知る手段が
// スクリプト本体のコメントしか無い。さらに --help はそれを一切案内せず、判定器仕様の
// 拠り所として名指ししているファイルは plugin に同梱されず配布先に届かない。
// このブロックは新規ドキュメント reference/size-tier-conf.md を前提にする（Phase 2 で実装済み）。

const REFERENCE_DOC = path.join(__dirname, '..', 'reference', 'size-tier-conf.md');
// dev-setup/SKILL.md の B1-3.6（Issue #45 Phase 3・AC6 の producer）は AC56/AC57 が使う。
const DEV_SETUP_MD = path.join(__dirname, '..', '..', 'dev-setup', 'SKILL.md');

// load_conf() の case "$line" in ブロックを実際にパースして conf キー集合を取る。
// AC37 の parsePatternArray() と同じ思想: JS 側にキー配列を転記すると、両方書き換えれば
// 通ってしまう「ミラー」になる（#44 の教訓）。転記せず毎回スクリプトから読み直す。
function parseConfCaseKeys() {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const caseStart = src.indexOf('case "$line" in');
  assert.ok(
    caseStart >= 0,
    'load_conf() から case "$line" in ブロックを見つけられなかった（スクリプト側の実装が変わった可能性がある）',
  );
  const esacIdx = src.indexOf('esac', caseStart);
  assert.ok(esacIdx >= 0, 'case "$line" in に対応する esac が見つからない');
  const block = src.slice(caseStart, esacIdx);

  const keys = new Set();
  for (const rawLine of block.split('\n')) {
    const line = rawLine.trim();
    // 分岐パターンは行頭で "<パターン>)" の形を取る（同一行に処理が続く場合も含む）。
    // "value=..." や "WARNINGS+=(...)" のような本文行は許可文字集合の途中で ')' の
    // 直前に来ない文字（"、+ 等）が挟まるため、この正規表現には一致しない。
    const m = /^([A-Za-z0-9_:=*]+)\)/.exec(line);
    if (!m) continue;
    let key = m[1];
    if (key === '*') continue; // catch-all はキーではないので除外する
    if (key.endsWith('*')) key = key.slice(0, -1); // "frontend:*" -> "frontend:" 等、末尾の * を正規化
    keys.add(key);
  }
  return keys;
}

// reference/size-tier-conf.md の「## キー一覧」節にある表の第1列（バッククォート内）を取る。
function parseDocKeyTable(mdPath) {
  assert.ok(
    fs.existsSync(mdPath),
    `${mdPath} がまだ存在しない（Issue #45 Phase 2 の実装対象そのもの。conf の記法を説明した唯一のドキュメントが無い）`,
  );
  const md = fs.readFileSync(mdPath, 'utf8');
  const body = section(md, '## キー一覧');
  const keys = new Set();
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim());
    const firstCell = cells[1] || '';
    if (!firstCell || /^:?-+:?$/.test(firstCell)) continue; // "|---|---|" の区切り行は表の値ではない
    const m = /`([^`]+)`/.exec(firstCell);
    if (m) keys.add(m[1]);
  }
  return keys;
}

test('AC47（Issue #45 AC3）: 記法ドキュメントとスクリプトの conf キー集合が双方向で一致する', (t) => {
  const scriptKeys = parseConfCaseKeys();
  assert.ok(
    scriptKeys.size > 0,
    'スクリプトの case "$line" in から conf キーを1つも取れなかった（パーサ自体がスクリプトの実装とズレている）',
  );
  const docKeys = parseDocKeyTable(REFERENCE_DOC);
  assert.ok(
    docKeys.size > 0,
    'reference/size-tier-conf.md の「## キー一覧」表からキーを1つも取れなかった（表が空か、節が見つからない）',
  );

  const missingInDoc = [...scriptKeys].filter((k) => !docKeys.has(k)).sort();
  const missingInScript = [...docKeys].filter((k) => !scriptKeys.has(k)).sort();

  assert.deepEqual(
    missingInDoc,
    [],
    `スクリプトが解釈する conf キーがドキュメントに説明されていない（記法を知る手段が本体コメントしか無い状態が続く）: ${JSON.stringify(missingInDoc)}`,
  );
  assert.deepEqual(
    missingInScript,
    [],
    `ドキュメントに書かれているがスクリプトは実際には解釈しない、架空の conf キーがある: ${JSON.stringify(missingInScript)}`,
  );
});

test('AC48（Issue #45 AC4）: --help が conf 記法ドキュメントの場所を案内する', (t) => {
  const res = runScript(['--help']);
  // --help は stdout に JSON を出さず、print_usage() が stderr に書いて exit 2 する契約
  // （parseJsonOutput は exit 0 前提なのでここでは使わない）。この契約自体も壊れていないか
  // 同時に確認する。
  assert.equal(
    res.status,
    2,
    `--help の終了コード契約（exit 2）が壊れている: ${res.status}。stderr: ${res.stderr}`,
  );
  assert.ok(
    res.stderr.includes('skills/_shared/reference/size-tier-conf.md'),
    `--help の出力（stderr）に conf 記法ドキュメントの案内が無い: ${JSON.stringify(res.stderr)}`,
  );
});

// AC49: 「配布されないファイルを仕様の拠り所と宣言している」記述が残っていないかを検査する。
// 対象語を2つの定数に分け、この2つを **同一行に並べて書かない**（この検査コード自身も
// 検査対象ファイルの1つに含まれるため、同一行に両方書くと自己参照で永久に赤くなる）。
const NEEDLE_A = 'phase1-contract';
const NEEDLE_B = '唯一のソース';

test('AC49（Issue #45 AC5）: 配布されない参照ファイルの言及行が「正のソース」宣言と同居していない', (t) => {
  // 経緯としての言及（NEEDLE_A だけを含む行）は正当なので禁止しない。禁じたいのは
  // 「plugin 非同梱のファイルを仕様の拠り所だと宣言すること」だけ。ファイル全体で
  // 両語の有無を見ると無関係な行がデコイになるため、行単位で同居を見る。
  const targets = [
    SCRIPT,
    __filename,
    path.join(__dirname, 'skill-md-gate-tables.test.js'),
  ];
  const violations = [];
  for (const file of targets) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, idx) => {
      if (line.includes(NEEDLE_A) && line.includes(NEEDLE_B)) {
        violations.push(`${file}:${idx + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(
    violations,
    [],
    `plugin に同梱されず配布先に届かないファイルを仕様の拠り所と宣言している行が残っている（言及そのものは可、宣言だけがNG）:\n${violations.join('\n')}`,
  );
});

// AC50: 「強化は無音・緩和は必ず警告」という非対称（load_conf() 末尾、§3.1）をドキュメントが
// 説明しているか。#44 で「語の存在だけを見るテストは指示を反転しても pass する」事故を
// 8回踏んでいるため、語の存在ではなく挙動を説明する行そのものを字面で固定する。
const ASYMMETRY_LINE =
  '厳しくする方向（risk: の追加・frontend: の追加・backend: の追加・閾値の引き下げ）は無音、緩める方向（*_reset・exclude: の追加・閾値の引き上げ）は必ず warnings に出る';

// AC50 が見るべき節。AC47（キー一覧）と同様に section() で節内に限定する（レンズ A Minor:
// AC50 だけ whole-file includes で配置を固定しておらず、非対称の説明行が無関係な節
// （例: 「較正の考え方と実例」のコード例コメント）に紛れ込んでも検出できなかった）。
const ASYMMETRY_HEADING = '## 強化は無音・緩和は必ず警告';

test('AC50: 記法ドキュメントが「強化は無音・緩和は必ず警告」の非対称を、専用の節の中で説明している', (t) => {
  assert.ok(
    fs.existsSync(REFERENCE_DOC),
    'reference/size-tier-conf.md がまだ存在しない（Issue #45 Phase 2 の実装対象そのもの）',
  );
  const md = fs.readFileSync(REFERENCE_DOC, 'utf8');
  const body = section(md, ASYMMETRY_HEADING);
  assert.ok(
    body.includes(ASYMMETRY_LINE),
    `記法ドキュメントの「${ASYMMETRY_HEADING}」節の中に、「強化は無音・緩和は必ず警告」の非対称を説明する行が無い` +
      '（節の外にあるだけでは不十分。実装は次の行をこの節の中にそのまま含めること): ' +
      ASYMMETRY_LINE,
  );
});

// --- AC51〜AC55（Issue #45 Phase 2 敵対的検証 統合レポートの無検知9種を塞ぐ）------------------
//
// .agent/adversarial-review-45-phase2-統合.md の「レンズ A の変異注入（無検知9種）」と
// 3レンズ収束の U-1/U-3/U-4、Minor の B-6/A-Minor を踏まえる。共通方針は #44 の教訓と同じ:
// 「語の存在」ではなく「挙動を決めている行そのもの」を見る。転記ミラーも作らない
// （AC37/AC47 と同じくスクリプトから実パースする）。

// --- AC51（U-1）: parseConfCaseKeys() の case 分岐取りこぼしを検出する -------------------------
//
// 正規表現 /^([A-Za-z0-9_:=*]+)\)/ は alternation（`a:*|b:*)`）・先頭括弧（`(a:*)`）・
// 入れ子 esac 以降の分岐を静かに取りこぼす。取りこぼした分岐は AC47 の双方向差分が
// 「両方とも空」のまま緑になるため、「新キーを足したがドキュメントに書かない」がそのまま
// 素通りする（レンズ A が fixture 実行でキーが実際に生きていることまで確認済み）。
//
// 対策は「拾えなかったことに気づく」機構: case ブロック内の ";;" の個数を数え、
// parseConfCaseKeys() が拾ったキー数 + 1（catch-all "*)" の分）と一致するかを見る。
// ";;" の数え上げは parseConfCaseKeys() とは独立に、case/esac の対応を深さで数えて
// 本当の閉じ esac を特定する（parseConfCaseKeys() 側の `indexOf('esac', ...)`は
// 最初に現れた esac で止まるため、入れ子 esac を含む分岐が増えるとブロックそのものが
// 短く誤認識される可能性がある。";;" 側は独立した数え方をすることで、この誤認識にも
// 引きずられずに済む）。

function findMatchingEsacIndex(src, caseStart) {
  const re = /\bcase\b|\besac\b/g;
  re.lastIndex = caseStart;
  let depth = 0;
  let m;
  while ((m = re.exec(src))) {
    if (m[0] === 'case') {
      depth++;
    } else {
      depth--;
      if (depth === 0) return m.index;
    }
  }
  return -1;
}

function countCaseTerminators() {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const caseStart = src.indexOf('case "$line" in');
  assert.ok(
    caseStart >= 0,
    'load_conf() から case "$line" in ブロックを見つけられなかった（スクリプト側の実装が変わった可能性がある）',
  );
  const esacIdx = findMatchingEsacIndex(src, caseStart);
  assert.ok(
    esacIdx >= 0,
    'case "$line" in に対応する esac が見つからない（入れ子の case/esac の対応が取れていない）',
  );
  const block = src.slice(caseStart, esacIdx);
  const terminators = block.match(/;;/g) || [];
  return terminators.length;
}

test('AC51: case "$line" in の分岐取りこぼしを ";;" の個数とキー数の突き合わせで検出する', (t) => {
  const keys = parseConfCaseKeys();
  const terminatorCount = countCaseTerminators();
  assert.equal(
    terminatorCount,
    keys.size + 1,
    `case "$line" in の ";;" は ${terminatorCount} 個ある（catch-all "*)" の分を含めれば ` +
      `キー数 + 1 = ${keys.size + 1} 個であるはず）のに、parseConfCaseKeys() が拾ったキーは ` +
      `${keys.size} 個しかない。差分は正規表現 /^([A-Za-z0-9_:=*]+)\\)/ が alternation` +
      '（`a:*|b:*)`）・先頭括弧（`(a:*)`）・入れ子 esac の後続分岐のいずれかを拾えていないことを' +
      '意味する。取りこぼしたキーは AC47（記法ドキュメントとの突き合わせ）の双方向差分が両方とも' +
      '空のまま緑になるため、新キーの記法未記載が素通りする（U-1）',
  );
});

// --- AC52（U-3）: ドキュメントが述べる定数・正規表現をスクリプトから実パースして照合する ---------
//
// これまでのテストが守っていたのはキー名の集合（AC47）と非対称の1行（AC50）だけで、
// 64KB・200行・先頭ゼロ拒否といった記述内容そのものは誰も検査していなかった。
// レンズ A は実際に「64KB」を「128KB」に、「200行」を「500行」に書き換えても
// 91/91 緑のままであることを実測している。JS 側に値を転記すると同じ穴（両方書き換えれば
// deep equal が通る）を再生産するため、スクリプトから実パースした値を検索に使う。

// ⚠ 初回マッチだけを返してはならない。閾値の妥当性検証のように**同じ書式がスクリプト内に
// 複数回現れる**箇所があり、初回だけを見ると2つ目以降が単独でドリフトしても無検知になる
// （実測: threshold_l 側の正規表現だけを `^[0-9]+$` に緩めても 99/99 緑だった）。
// 全一致を集めて、値が食い違っていればそれ自体を欠陥として落とす。
function parseScriptCapture(regex, label) {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const all = [...src.matchAll(new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g'))];
  assert.ok(
    all.length > 0,
    `スクリプトから ${label} をパースできなかった（想定した書式が変わった。パーサ側の追随が必要）`,
  );
  const values = [...new Set(all.map((m) => m[1]))];
  assert.deepStrictEqual(
    values.length, 1,
    `スクリプト内で ${label} の値が一致していない: ${JSON.stringify(values)}。` +
      '同じ役割の検査が箇所によって違う挙動になっており、ドキュメントはそのうち1つしか説明できない',
  );
  return values[0];
}

test('AC52a: conf のサイズ上限（バイト数）がドキュメントにそのまま現れる', (t) => {
  const bytes = parseScriptCapture(/\(\(\s*size\s*>\s*(\d+)\s*\)\)/, 'conf のサイズ上限（バイト数）');
  const md = fs.readFileSync(REFERENCE_DOC, 'utf8');
  assert.ok(
    md.includes(bytes),
    `スクリプトの conf サイズ上限は ${bytes} バイトだが、ドキュメントにこの数値がそのまま現れない` +
      '（「64KB」という表記だけでは、実装の閾値そのもの（65536）と一致しているかを機械的に確認できない。' +
      `実装が書くべき字面: 本文中のどこかに「${bytes}」を含めること）`,
  );
});

test('AC52b: conf の行数上限がドキュメントに「<n>行」の形で現れる', (t) => {
  const lineLimit = parseScriptCapture(/\(\(\s*line_no\s*>\s*(\d+)\s*\)\)/, 'conf の行数上限');
  const md = fs.readFileSync(REFERENCE_DOC, 'utf8');
  assert.match(
    md,
    new RegExp(`${lineLimit}\\s*行`),
    `スクリプトの行数上限は ${lineLimit} 行だが、ドキュメントに「${lineLimit}行」の形で現れない` +
      `（実装が書くべき字面: 「${lineLimit}行」または「${lineLimit} 行」）`,
  );
});

test('AC52c: 閾値の妥当性を検証する正規表現がドキュメントにそのまま現れる', (t) => {
  const validityRegex = parseScriptCapture(
    /"\$value"\s+=~\s+(\S+)\s+\]\]/,
    '閾値の妥当性を検証する正規表現',
  );
  const md = fs.readFileSync(REFERENCE_DOC, 'utf8');
  assert.ok(
    md.includes(validityRegex),
    `スクリプトの閾値妥当性チェックは ${validityRegex} だが、ドキュメントにこの正規表現がそのまま` +
      `現れない（実装が書くべき字面: 「${validityRegex}」をそのまま含めること）`,
  );
});

test('AC52d: threshold_m / threshold_l の既定値がドキュメントに「既定 <n>」の形で現れる', (t) => {
  const defaultM = parseScriptCapture(/DEFAULT_THRESHOLD_M=(\d+)/, 'DEFAULT_THRESHOLD_M');
  const defaultL = parseScriptCapture(/DEFAULT_THRESHOLD_L=(\d+)/, 'DEFAULT_THRESHOLD_L');
  const md = fs.readFileSync(REFERENCE_DOC, 'utf8');
  assert.match(
    md,
    new RegExp(`既定\\s*${defaultM}`),
    `threshold_m の既定値は ${defaultM} だが、ドキュメントに「既定 ${defaultM}」の形で明示されていない` +
      '（既存の「既定値（100/500）」という併記だけでは、値を変えたときにどちらが threshold_m で' +
      `どちらが threshold_l かを機械的に判別できない。実装が書くべき字面: 「既定 ${defaultM}」）`,
  );
  assert.match(
    md,
    new RegExp(`既定\\s*${defaultL}`),
    `threshold_l の既定値は ${defaultL} だが、ドキュメントに「既定 ${defaultL}」の形で明示されていない` +
      `（実装が書くべき字面: 「既定 ${defaultL}」）`,
  );
});

// --- AC53（U-4）: 「配布されないファイルを正のソースと宣言する」検査を言い換えに強くする --------
//
// AC49 は禁止語1つ（'唯一のソース'）・対象3ファイルのハードコード allowlist だったため、
// 「仕様の正は…」「判断の拠り所は…」のような言い換えは無条件で素通りしていた（#44 で8回
// 踏んだ「語の存在で見ているので言い換え・反転が通る」型そのもの）。対象も新設ドキュメント
// 自身（reference/size-tier-conf.md）が入っていなかった。両方を広げる。
//
// ⚠ 自己参照に注意: この検査コード自身が対象ファイルに含まれる。NEEDLE_A（'phase1-contract'）と
// 禁止語を同じ行に書かない（AC49 と同じ理由。NEEDLE_A は既存定数を再利用し、この配列の行には
// 書かない）。
const BANNED_DECLARATION_PHRASES = ['唯一のソース', '拠り所', '仕様の正', '正のソース'];

function listPluginTextFiles() {
  const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: __dirname,
    encoding: 'utf8',
  }).trim();
  const tracked = execFileSync('git', ['ls-files', '--', 'plugins'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .filter(Boolean);
  return tracked.filter((rel) => /\.(md|sh|js|mjs)$/.test(rel)).map((rel) => path.join(repoRoot, rel));
}

test('AC53: 配布されないファイルを「正のソース」だと宣言する行が、言い換え・新設ドキュメントも含めて存在しない', (t) => {
  const targets = listPluginTextFiles();
  assert.ok(
    targets.length > 0,
    'plugins/ 配下の .md/.sh/.js/.mjs を1つも列挙できなかった（git ls-files の実行が壊れている可能性がある）',
  );

  const violations = [];
  for (const file of targets) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, idx) => {
      if (!line.includes(NEEDLE_A)) return;
      const hitPhrase = BANNED_DECLARATION_PHRASES.find((p) => line.includes(p));
      if (hitPhrase) {
        violations.push(`${path.relative(path.dirname(SCRIPT), file)}:${idx + 1} [${hitPhrase}]: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(
    violations,
    [],
    'plugin に同梱されず配布先に届かないファイルを「正のソース」だと言い換えを含めて宣言している行がある' +
      `（言及そのものは可、宣言だけがNG。対象は plugins/ 配下の .md/.sh/.js/.mjs 実 ${targets.length} 件）:\n` +
      violations.join('\n'),
  );
});

// --- AC54（B-6）: 「緩和方向」の理由列挙が実装とドリフトしていないことを検査する ------------------
//
// load_conf() 末尾の loosened 判定は reasons+=("...") で緩和方向の理由を積む。この理由の集合を
// 実際にパースし、ドキュメント側の「## 警告が出る条件」表の列挙と双方向で突き合わせる。
// AC47/AC37 と同じ非ミラー方式（JS 側に理由の配列を転記しない）。これが無いと、実装から
// reasons を1つ削っても（例: exclude追加を削る＝conf に exclude: を足しても無音化する）
// ドキュメントは何も知らないまま緑であり続ける。

function parseLoosenedReasons() {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const re = /reasons\+=\("([^"]+)"\)/g;
  const reasons = new Set();
  let m;
  while ((m = re.exec(src))) {
    reasons.add(m[1]);
  }
  assert.ok(
    reasons.size > 0,
    'load_conf() から reasons+=("...") を1つも取れなかった（loosened 判定の実装が変わった可能性がある）',
  );
  return reasons;
}

// reference/size-tier-conf.md の「## 警告が出る条件」節にある表の第1列（バッククォート内）を取る。
// parseDocKeyTable() と構造は同じだが、対象節が違うため独立関数にする（節が改名されたときに
// どちらの表が壊れたのか切り分けられるように、切り出しロジックを共有しすぎない）。
function parseDocReasonsTable(mdPath) {
  assert.ok(
    fs.existsSync(mdPath),
    `${mdPath} がまだ存在しない`,
  );
  const md = fs.readFileSync(mdPath, 'utf8');
  const body = section(md, '## 警告が出る条件');
  const reasons = new Set();
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim());
    const firstCell = cells[1] || '';
    if (!firstCell || /^:?-+:?$/.test(firstCell)) continue;
    const m = /`([^`]+)`/.exec(firstCell);
    if (m) reasons.add(m[1]);
  }
  return reasons;
}

test('AC54: 「緩和方向」で warnings に出る理由の集合が実装とドキュメントで双方向一致する', (t) => {
  const implReasons = parseLoosenedReasons();
  const docReasons = parseDocReasonsTable(REFERENCE_DOC);

  const missingInDoc = [...implReasons].filter((r) => !docReasons.has(r)).sort();
  const missingInImpl = [...docReasons].filter((r) => !implReasons.has(r)).sort();

  assert.deepEqual(
    missingInDoc,
    [],
    'load_conf() の reasons+=(...) にあるのにドキュメントの「## 警告が出る条件」表に無い理由がある' +
      `: ${JSON.stringify(missingInDoc)}。実装が書くべき表の第1列（バッククォート付き）は次の7つ: ` +
      '`risk_reset` `exclude_reset` `exclude追加` `frontend_reset` `backend_reset` ' +
      '`threshold_m引き上げ` `threshold_l引き上げ`',
  );
  assert.deepEqual(
    missingInImpl,
    [],
    `ドキュメントの「## 警告が出る条件」表にあるが実装の reasons+=(...) には無い、架空の理由がある: ${JSON.stringify(missingInImpl)}`,
  );
});

// --- AC55（A-Minor）: --help の案内先が実在すること --------------------------------------------
//
// AC48 は --help の stdout/stderr に文字列が含まれることしか見ておらず、案内先パスが実在するか
// までは確認していない。「size-tier-conf.md.old」のような存在しないパスを案内していても
// AC48 は緑のまま（レンズ A が変異注入で実測）。パスは JS 側に転記せず、--help の実出力から
// 一般的な *.md パターンで取り出す。

// ⚠ `/[\w./_-]+\.md/` で書かないこと。それは**トークンの途中で止まる**ため、案内が
// `size-tier-conf.md.old` にすり替わっても `size-tier-conf.md` までを取り出してしまい、
// 実在チェックが通る（実測: 案内先を .md.old に変える変異が 99/99 緑だった）。
// パスらしい文字の**最大トークン**を切り出してから .md を含むものを選ぶ。
function extractHelpDocPaths(stderrText) {
  const tokens = stderrText.match(/[\w./_-]+/g) || [];
  const paths = tokens.filter((tk) => tk.includes('.md'));
  assert.ok(
    paths.length > 0,
    '--help の出力から *.md 形式のドキュメントパスを取り出せなかった',
  );
  return paths;
}

test('AC55: --help が案内する記法ドキュメントは、案内どおりの場所に実在する', (t) => {
  const res = runScript(['--help']);
  assert.equal(res.status, 2, `--help の終了コード契約（exit 2）が壊れている: ${res.status}`);

  // --help の案内は plugin ルート相対（skills/_shared/reference/... の形）で書かれている
  // 契約（消費側6箇所と同形）。SCRIPT は <plugin root>/skills/_shared/scripts/ 配下なので、
  // 3つ上がると plugin ルートに一致する。
  const pluginRoot = path.resolve(path.dirname(SCRIPT), '..', '..', '..');
  const missing = extractHelpDocPaths(res.stderr).filter(
    (rel) => !fs.existsSync(path.join(pluginRoot, rel)),
  );
  assert.deepStrictEqual(
    missing, [],
    `--help が案内する md パスが実在しない: ${missing.join(', ')}（plugin ルート: ${pluginRoot}）。` +
      'AC48（文字列一致だけ）はこの状態（案内先が存在しないパスにすり替わる）に気づけない',
  );
});

// --- AC56〜AC57（Issue #45 Phase 3 / AC6）: docs/testing/size-tier.conf.template の producer ---
//
// 背景: .agent/size-tier.conf の較正テンプレートを**作る**手順が dev-flow のどこにも無い
// （#44 で機構＝判定器側の警告と dev-setup B1-3.5 のコピー手順は作ったが、コピー元の
// テンプレート自体を生成する producer が存在しない。実測: ホーム配下で業務リポジトリの
// worktree 1件にしか実在せず、それも人手で作られたもの）。
// dev-setup/SKILL.md に新設される `#### B1-3.6.` が producer になる。
//
// ⚠ 字面 pin にしないこと（#44 で2フェーズかけて潰した転記ミラーの再生産を避ける）。
// B1-3.6 の中にある conf 実例をコードフェンス（info string は `conf`）から**実際に
// 抜き出し**、fixture リポジトリに書き込んで**本物の判定器を実行**し、
// 「較正が効いていない」系の warnings が出ないことを assert する。ドキュメントに書いた
// 実例そのものが検査対象になるので、JS 側に値を転記する余地が無い。
//
// 「較正が効いていない」系の警告2本（load_conf() 493〜525行目）はどちらも
// CONF_TEMPLATE_PATH（= CONF_TEMPLATE 定数）を文中に含む。AC39/AC42/AC42b/AC42c/AC44/AC45 と
// 同じ識別方法（`w.includes(CONF_TEMPLATE)`）をそのまま使う。「既定を緩めている」警告
// （545行目）は CONF_TEMPLATE_PATH を含まないので、この照合には混ざらない。

const B1_3_6_HEADING = '#### B1-3.6.';

// dev-setup/SKILL.md の B1-3.6 節から ```conf フェンスの中身を抜き出す。
// info string を "conf" に固定しているのは実装側との約束（報告に明記）。
function extractB1_3_6ConfExample() {
  const md = fs.readFileSync(DEV_SETUP_MD, 'utf8');
  const body = section(md, B1_3_6_HEADING);
  // ⚠ .exec()（最初の一致）で抜き出さないこと。実測（Issue #45 Phase 3 敵対的検証
  //   A M-1 / B m-1）: 節の先頭に有効なデコイの ```conf フェンスを1個足しつつ本物を
  //   全コメントアウトすると、.exec() は先頭のデコイだけを拾って AC56 が全 pass した。
  //   全件抽出してちょうど1個であることを確認し、「どれが正しい実例か決まらない」
  //   状態そのものを欠陥として落とす。
  const fences = [...body.matchAll(/```conf\n([\s\S]*?)```/g)];
  assert.ok(
    fences.length > 0,
    'dev-setup/SKILL.md の B1-3.6 節に ```conf フェンスの実例が無い（info string は "conf" で書くこと）',
  );
  assert.equal(
    fences.length,
    1,
    `dev-setup/SKILL.md の B1-3.6 節に \`\`\`conf フェンスが ${fences.length} 個ある。` +
      'どれが正しい実例か決まらない。節内の ```conf フェンスは実例1個だけにすること',
  );
  return fences[0][1];
}

test('AC56: B1-3.6 の conf 実例をそのまま配ると conf_applied=1 になり、較正が効いていない警告が出ない', (t) => {
  const confExample = extractB1_3_6ConfExample();
  assert.ok(
    confExample.trim().length > 0,
    'B1-3.6 の ```conf フェンスから抜き出した実例が空（フェンスのパースに失敗している可能性がある）',
  );
  const effectiveLines = confExample.split('\n').filter((line) => {
    const t = line.trim();
    return t !== '' && !t.startsWith('#');
  });
  assert.ok(
    effectiveLines.length > 0,
    'B1-3.6 の conf 実例がコメントと空行だけで、実効的な設定行（閾値・risk/exclude/frontend/backend）が' +
      '1行も無い。この状態のテンプレートを配っても conf_applied=1 にならない',
  );

  const { dir, base } = newBaseRepo(t);
  // docs/testing/size-tier.conf.template と .agent/size-tier.conf の両方に同じ実例を置く。
  // 前者が無いと「テンプレートがあるのに conf が無い」の警告経路自体が発火しない
  // （AC41: テンプレートが無いリポでは no-op）ため、片方だけでは AC6 の実測にならない。
  writeText(dir, CONF_TEMPLATE, confExample);
  writeText(dir, '.agent/size-tier.conf', confExample);
  writeLines(dir, 'src/app.js', 10);
  const head = commit(dir, 'change');

  const out = parseJsonOutput(runScript(['--dir', dir, '--base', base, '--head', head]));
  assert.ok(
    !out.warnings.some((w) => w.includes(CONF_TEMPLATE)),
    `B1-3.6 が案内する conf 実例をそのまま配っても較正が効いていない警告が出ている: ` +
      `${JSON.stringify(out.warnings)}（B1-3.6 の実例に実効的な設定行を入れること）`,
  );
});

test('AC57（逆向き）: B1-3.6 の実例から実効行だけをコメントアウトすると較正が効いていない警告に戻る', (t) => {
  // AC56 の緑が「conf の中身に関わらず常に緑」になっていないことの裏取り。
  // 片方向だけだと、fixture の書き込みや判定器の起動自体が壊れていても気づけない
  // （#44 で「何を書いても緑」の失敗を延べ10回踏んでいる同型の穴）。
  const confExample = extractB1_3_6ConfExample();
  const commentedOut = confExample
    .split('\n')
    .map((line) => (line.trim() === '' || line.trim().startsWith('#') ? line : `# ${line}`))
    .join('\n');

  const { dir, base } = newBaseRepo(t);
  writeText(dir, CONF_TEMPLATE, confExample);
  writeText(dir, '.agent/size-tier.conf', commentedOut);
  writeLines(dir, 'src/app.js', 10);
  const head = commit(dir, 'change');

  const out = parseJsonOutput(runScript(['--dir', dir, '--base', base, '--head', head]));
  assert.ok(
    out.warnings.some((w) => w.includes(CONF_TEMPLATE)),
    `B1-3.6 の実例から実効行を全てコメントアウトしても較正が効いていない警告が出ていない: ` +
      `${JSON.stringify(out.warnings)}（AC56 が「何を書いても緑」になっている可能性がある）`,
  );
});

test('AC58: B1-3.6 の conf 実例の全行が判定器に解釈される（フェンス閉じ忘れ・部分的な記法違反の検知）', (t) => {
  // Issue #45 Phase 3 敵対的検証 B M-6 / A M-2:
  //
  // B M-6（フェンスの閉じ忘れ）: ```conf の閉じ ``` が失われると、section() の節境界は
  // 次の ``` まで（B2〜B6 の別のコードフェンスまで）突き抜ける。抽出結果は依然として
  // 「フェンス1個」なので AC58 で足した fences.length===1 のガード（T3）はすり抜け、
  // 実測では B2〜B6 の本文 約4.4KB を conf として書き込みながら AC56 は緑のままだった。
  //
  // A M-2（部分的な記法違反）: `threshold_m = 150`（`=` 前後の空白）は load_conf() が
  // 「解釈できなかった」警告を出すが、その警告は CONF_TEMPLATE_PATH を含まないため
  // AC56/AC57 の照合（w.includes(CONF_TEMPLATE)）には一切現れない。B1-3.6 step 3 が
  // 自ら警告している失敗そのものを、これまでどのテストも見ていなかった。
  //
  // ⚠ **行末コメントだけはこの0件チェックで捕まらない**（実測）。`exclude: **/e2e/**  # 理由`
  // は `exclude:*)` に一致し、値が `**/e2e/**  # 理由` として**正常に登録される**ので
  // 警告が1件も出ない。そのうえでパターンは実在するパスに永久に一致しない、という
  // 最悪の失敗（無音）になる。下の別 assert で字面から直接弾く。
  //
  // どちらも「抽出した内容の全行を判定器に食わせ、'解釈できなかった' 警告が1件も
  // 出ないこと」を見れば同時に塞げる。閉じ忘れで無関係な散文（見出し・箇条書き・
  // 説明文）が混入すればその行の大半が `load_conf()` の既知パターンに当たらず
  // 「解釈できなかった」を量産し、記法違反も同じ警告で検出される。
  const confExample = extractB1_3_6ConfExample();

  const { dir, base } = newBaseRepo(t);
  writeText(dir, CONF_TEMPLATE, confExample);
  writeText(dir, '.agent/size-tier.conf', confExample);
  writeLines(dir, 'src/app.js', 10);
  const head = commit(dir, 'change');

  const out = parseJsonOutput(runScript(['--dir', dir, '--base', base, '--head', head]));
  const unparsed = out.warnings.filter((w) => w.includes('解釈できなかった'));
  assert.deepStrictEqual(
    unparsed,
    [],
    'B1-3.6 の conf 実例に判定器が解釈できない行が含まれている:\n' +
      JSON.stringify(unparsed, null, 2) +
      '\n（閉じ ``` の欠落で節境界が突き抜けて無関係な本文を拾っているか、' +
      '`=` 前後の空白・行末コメントなど記法違反が混ざっている可能性がある。' +
      'warnings は20件で打ち切られるため、この0件チェックが唯一の検知経路）',
  );
});

// 行末コメントは判定器が値の一部として黙って受理する（実測: `exclude: **/e2e/**  # 理由` は
// 警告ゼロで登録され、そのパターンは実在パスに永久に一致しない）。AC58 の「解釈できなかった
// 0件」チェックでは原理的に捕まらないので、字面から直接弾く。B1-3.6 step 3 が
// 「行末コメント非対応」と警告している当の失敗を、実例自身が踏まないようにするための固定。
test('AC58b: B1-3.6 の conf 実例に行末コメントが混ざっていない（判定器が無音で受理するため）', () => {
  const lines = extractB1_3_6ConfExample().split('\n');
  const withTrailingComment = lines.filter(
    (l) => l.trim() && !l.trimStart().startsWith('#') && l.includes('#'),
  );
  assert.deepStrictEqual(
    withTrailingComment,
    [],
    'B1-3.6 の conf 実例に行末コメントが混ざっている:\n' +
      withTrailingComment.join('\n') +
      '\n（判定器は `#` 以降も値の一部として受理するため警告が出ず、そのパターンは' +
      '実在するパスに永久に一致しない。コメントは行頭 `#` の独立行にすること）',
  );
});

// --- AC70〜AC73: メインセッションのモデルによる検証ゲートの軽量化 -----------------
//
// 自己検証するモデル（SELF_VERIFYING_MODELS）のときだけ自己検証の重ね掛けを外す。
// 期待値は判定器の配列を写さず、ここに直接書く（両方を同時に書き換えたときに通らないように）。

const SELF_REVIEW_S_SV = ['dev-flow:requirement-coverage-checker', 'dev-flow:Code-Reviewer'];
const SELF_REVIEW_ML_SV = [...SELF_REVIEW_S_SV, 'dev-flow:codex-cross-reviewer'];

function bandRepo(t, size, risk) {
  const { dir, base } = newBaseRepo(t);
  const rel = risk === 'HIGH' ? 'src/api/x.ts' : 'src/util/x.ts';
  writeLines(dir, rel, { S: 50, M: 200, L: 700 }[size]);
  return { dir, base, head: commit(dir, 'change') };
}

test('AC70: 自己検証モデルでは、6帯すべてでレンズは A（HIGH は +D）・Code-Reviewer は ship・セルフレビューは軽い顔ぶれ', (t) => {
  for (const size of ['S', 'M', 'L']) {
    for (const risk of ['LOW', 'HIGH']) {
      const { dir, base, head } = bandRepo(t, size, risk);
      const out = parseJsonOutput(
        runScript(['--dir', dir, '--base', base, '--head', head, '--main-model', 'claude-opus-5[1m]']),
      );
      const key = `${size}×${risk}`;
      assert.equal(out.size, size, `${key}: fixture の帯がずれている`);
      assert.equal(out.risk, risk, `${key}: fixture のリスクがずれている`);
      assert.equal(out.main_model, 'claude-opus-5', `${key}: [1m] の注記が落ちていない`);
      assert.equal(out.verification_profile, 'self_verifying', key);
      assert.deepEqual(out.gates.adversarial_lenses, risk === 'HIGH' ? ['A', 'D'] : ['A'], key);
      assert.equal(out.gates.code_reviewer, 'ship', key);
      assert.deepEqual(out.gates.self_review_members, size === 'S' ? SELF_REVIEW_S_SV : SELF_REVIEW_ML_SV, key);
      // 自己検証では代わりにならないゲートは standard と同じ値のまま
      const std = parseJsonOutput(runScript(['--dir', dir, '--base', base, '--head', head]));
      for (const g of ['security_review', 'test_ledger', 'explain_diff', 'qa']) {
        assert.deepEqual(out.gates[g], std.gates[g], `${key}: ${g} がモデルで変わっている`);
      }
    }
  }
});

test('AC71: Fable 5 / Fable 5.1 も自己検証モデルとして扱い、大文字小文字の揺れを吸収する', (t) => {
  const { dir, base, head } = bandRepo(t, 'L', 'LOW');
  for (const model of ['claude-fable-5', 'claude-fable-5-1', 'Claude-Opus-5']) {
    const out = parseJsonOutput(runScript(['--dir', dir, '--base', base, '--head', head, '--main-model', model]));
    assert.equal(out.verification_profile, 'self_verifying', model);
    assert.deepEqual(out.gates.adversarial_lenses, ['A'], model);
  }
});

test('AC72: 未指定・他モデル・派生名は standard のまま（前方一致で軽くしない）', (t) => {
  const { dir, base, head } = bandRepo(t, 'L', 'LOW');
  for (const args of [[], ['--main-model', 'claude-sonnet-5'], ['--main-model', 'gpt-5'], ['--main-model', 'claude-opus-5-9'], ['--main-model', '']]) {
    const out = parseJsonOutput(runScript(['--dir', dir, '--base', base, '--head', head, ...args]));
    const label = JSON.stringify(args);
    assert.equal(out.verification_profile, 'standard', label);
    assert.deepEqual(out.gates.adversarial_lenses, ['A', 'B', 'C'], label);
    assert.equal(out.gates.code_reviewer, 'per_phase', label);
    assert.deepEqual(out.gates.self_review_members, SELF_REVIEW_ML, label);
  }
});

test('AC73: 判定不能（fallback）のときは自己検証モデルでも L×HIGH のフル装備に倒す', (t) => {
  const dir = makeFixtureDir(t); // git repo ではない
  const out = parseJsonOutput(runScript(['--dir', dir, '--main-model', 'claude-opus-5']));
  assert.equal(out.fallback, true);
  assert.equal(out.main_model, 'claude-opus-5');
  assert.equal(out.verification_profile, 'standard');
  assert.deepEqual(out.gates.adversarial_lenses, ['A', 'B', 'C', 'D']);
  assert.equal(out.gates.code_reviewer, 'per_phase');
  assert.deepEqual(out.gates.self_review_members, SELF_REVIEW_ML);
});
