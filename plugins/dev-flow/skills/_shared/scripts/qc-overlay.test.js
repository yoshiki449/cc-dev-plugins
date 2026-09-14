#!/usr/bin/env node
'use strict';

// qc-overlay.sh と、overlay 契約の消費側（SKILL.md / agents）のテスト。
// 実行: node --test plugins/dev-flow/skills/_shared/scripts/qc-overlay.test.js
//
// 契約の正は qc-overlay.sh 本体と skills/_shared/reference/qc-overlay.md。設計の経緯は Issue #83。
//
// この判定器が誤って「overlay が適用された」側に倒れると、組織固有の QC 観点が1つも
// 効いていないのに誰も気づかない。とくに配布物がコメントだけの空雛形で届くケースは
// assess-change-size.sh の conf_applied がまさにその穴を塞ぐために導入されたもので、
// ここも同型。AC の多くは「本来 applied=0 になるはずの入力が本当に 0 で出るか」を assert する。
//
// 消費側の検査は、語の存在ではなく**挙動を決めている行そのもの**を見る。
// このリポジトリでは「ドキュメントを検査するテストが、守りたい挙動ではなくその挙動について
// 語っている解説文にマッチして、指示を反転しても pass する」欠陥を繰り返し踏んでいるため、
// 消費側の呼び出し行は契約側に正準を持ち、byte-identical で突き合わせる。

const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { section } = require('./md-section.js');

const SCRIPT = path.join(__dirname, 'qc-overlay.sh');
const SHARED = path.join(__dirname, '..');
const SKILLS = path.join(SHARED, '..');
const PLUGIN = path.join(SKILLS, '..');
const CONTRACT = path.join(SHARED, 'reference', 'qc-overlay.md');

function run(args, env) {
  return spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    cwd: os.tmpdir(),
    env: { ...process.env, ...(env || {}) },
  });
}

function json(args, env) {
  const r = run(args, env);
  assert.strictEqual(r.status, 0, `exit 0 であるべき: ${r.stderr}`);
  return JSON.parse(r.stdout.trim());
}

let tmpSeq = 0;
function mkOverlay(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `qc-overlay-${tmpSeq++}-`));
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), body);
  }
  return dir;
}

const MANIFEST = JSON.stringify({
  name: 'テスト組織 QC overlay',
  version: '1.0.0',
  reviewer_agent: 'test-overlay:qc-reviewer',
  phases: {
    plan: 'plan.md',
    impl: 'impl.md',
    'test-spec': 'test-spec.md',
    verify: 'verify.md',
    qa: 'qa.md',
    ship: 'ship.md',
    'test-model': 'test-model.md',
  },
}, null, 2);

const TABLE = ['| ID | 観点 |', '|---|---|', '| X1 | あ |', '| X2 | い |'].join('\n');

// ---------------------------------------------------------------------------
// AC1-AC4: overlay が無い／不完全なときに applied=0 で必ず音を立てる
// ---------------------------------------------------------------------------

test('AC1: overlay 未導入なら present=0 / applied=0 で警告を出し、exit 0 で返す', () => {
  const dir = mkOverlay({});
  const r = run(['--phase', 'plan', '--overlay-dir', dir]);
  // exit 0 を崩すと呼び出し側の set -e が死ぬ。overlay 無しは異常ではなく正常な分岐。
  assert.strictEqual(r.status, 0);
  const o = JSON.parse(r.stdout.trim());
  assert.strictEqual(o.overlay_present, 0);
  assert.strictEqual(o.overlay_applied, 0);
  assert.strictEqual(o.file, '');
  assert.ok(o.warnings.length > 0, 'overlay 未導入は必ず warnings に出す');
});

test('AC2: manifest はあるがフェーズファイルが無いなら present=1 / applied=0', () => {
  const dir = mkOverlay({ 'manifest.json': MANIFEST });
  const o = json(['--phase', 'plan', '--overlay-dir', dir]);
  assert.strictEqual(o.overlay_present, 1);
  assert.strictEqual(o.overlay_applied, 0);
  assert.strictEqual(o.file, '');
  assert.ok(o.warnings.length > 0);
});

test('AC3: 見出し行と区切り行だけの空テーブルは items=0 / applied=0（空雛形の穴）', () => {
  // これが本テストの中心。配布物がコメントだけ・表の骨だけで届いたとき、
  // present で判定していると警告が消える。assess-change-size.sh の conf_applied と同型。
  const dir = mkOverlay({
    'manifest.json': MANIFEST,
    'plan.md': ['# plan', '', '<!-- ここに観点を書く -->', '', '| ID | 観点 |', '|---|---|'].join('\n'),
  });
  const o = json(['--phase', 'plan', '--overlay-dir', dir]);
  assert.strictEqual(o.items, 0);
  assert.strictEqual(o.overlay_applied, 0, '空雛形を applied=1 にしてはいけない');
  assert.strictEqual(o.file, '', 'applied=0 のとき file は空（読ませない）');
  assert.ok(o.warnings.some((w) => w.includes('観点が0件')));
});

test('AC4: manifest が空ファイルなら present=0 / applied=0', () => {
  const dir = mkOverlay({ 'manifest.json': '' });
  const o = json(['--phase', 'plan', '--overlay-dir', dir]);
  assert.strictEqual(o.overlay_present, 0);
  assert.strictEqual(o.overlay_applied, 0);
  assert.ok(o.warnings.length > 0);
});

// ---------------------------------------------------------------------------
// AC5-AC9: 観点の数え方
// ---------------------------------------------------------------------------

test('AC5: 表のデータ行を数え、見出し行と区切り行は数えない', () => {
  const dir = mkOverlay({ 'manifest.json': MANIFEST, 'plan.md': `# plan\n\n${TABLE}\n` });
  const o = json(['--phase', 'plan', '--overlay-dir', dir]);
  assert.strictEqual(o.items, 2);
  assert.strictEqual(o.overlay_applied, 1);
  assert.strictEqual(o.file, path.join(dir, 'plan.md'));
  assert.deepStrictEqual(o.warnings, []);
});

test('AC6: 箇条書き行も観点として数える', () => {
  const dir = mkOverlay({
    'manifest.json': MANIFEST,
    'plan.md': ['# plan', '- あ', '* い', '+ う'].join('\n'),
  });
  assert.strictEqual(json(['--phase', 'plan', '--overlay-dir', dir]).items, 3);
});

test('AC7: コードフェンスの内側は数えない', () => {
  // フェンス内のシェルコメントを見出しと誤認して節が早期に切れる欠陥を過去に入れている。
  // 数える側でも同じ誤認が起きるので、フェンス内は丸ごと除外する。
  const dir = mkOverlay({
    'manifest.json': MANIFEST,
    'plan.md': ['# plan', '- 実物', '```', '| X | Y |', '- 偽物', '```'].join('\n'),
  });
  assert.strictEqual(json(['--phase', 'plan', '--overlay-dir', dir]).items, 1);
});

test('AC8: HTML コメント行と見出し行は数えない', () => {
  const dir = mkOverlay({
    'manifest.json': MANIFEST,
    'plan.md': ['# plan', '## 節', '<!-- - 偽物 -->', '- 実物'].join('\n'),
  });
  assert.strictEqual(json(['--phase', 'plan', '--overlay-dir', dir]).items, 1);
});

test('AC9: 引用の中の箇条書きは数えない（注記を観点と数えない）', () => {
  const dir = mkOverlay({
    'manifest.json': MANIFEST,
    'plan.md': ['# plan', '> - 注記', '- 実物'].join('\n'),
  });
  assert.strictEqual(json(['--phase', 'plan', '--overlay-dir', dir]).items, 1);
});

// ---------------------------------------------------------------------------
// AC10-AC12: reviewer_agent
// ---------------------------------------------------------------------------

test('AC10: reviewer_agent を manifest から取り出す', () => {
  const dir = mkOverlay({ 'manifest.json': MANIFEST, 'qa.md': TABLE });
  assert.strictEqual(json(['--phase', 'qa', '--overlay-dir', dir]).reviewer_agent, 'test-overlay:qc-reviewer');
});

test('AC11: reviewer_agent が無いなら空文字＋警告（dev-qa は3並列に落ちる）', () => {
  const dir = mkOverlay({
    'manifest.json': JSON.stringify({ name: 'x', phases: { qa: 'qa.md' } }),
    'qa.md': TABLE,
  });
  const o = json(['--phase', 'qa', '--overlay-dir', dir]);
  assert.strictEqual(o.reviewer_agent, '');
  assert.ok(o.warnings.some((w) => w.includes('reviewer_agent')));
  // 観点ファイル自体は読めているので applied は 1 のまま。agent の有無と混ぜない。
  assert.strictEqual(o.overlay_applied, 1);
});

test('AC12: 接頭辞なしの reviewer_agent は空文字に倒し、警告を出す', () => {
  // 接頭辞なしの subagent_type は ~/.claude/agents/ の同名コピーに解決される（Issue #25）。
  // そのまま渡すと「起動したつもりで別の旧版が動く」ので、起動させずに音を立てる。
  const dir = mkOverlay({
    'manifest.json': JSON.stringify({ reviewer_agent: 'qc-reviewer', phases: { qa: 'qa.md' } }),
    'qa.md': TABLE,
  });
  const o = json(['--phase', 'qa', '--overlay-dir', dir]);
  assert.strictEqual(o.reviewer_agent, '', '名前解決に失敗する agent 名は渡さない');
  assert.ok(o.warnings.some((w) => w.includes('qc-reviewer')));
});

// ---------------------------------------------------------------------------
// AC13-AC16: 引数・経路
// ---------------------------------------------------------------------------

test('AC13: 読むファイル名は <phase>.md 固定で、manifest では差し替えられない', () => {
  // 差し替えを許すと、判定器は差し替え先を見るのに agent はハードコードした <phase>.md を
  // 見るため、applied=1 なのに agent は「未適用」と報告する状態が作れてしまう。
  const dir = mkOverlay({
    'manifest.json': JSON.stringify({ phases: { plan: 'elsewhere.md' } }),
    'elsewhere.md': TABLE,
    'plan.md': TABLE,
  });
  const o = json(['--phase', 'plan', '--overlay-dir', dir]);
  assert.strictEqual(o.file, path.join(dir, 'plan.md'), 'manifest の phases に従ってはいけない');
});

test('AC14: 未知のフェーズ・--phase 欠落・--help はいずれも exit 2', () => {
  assert.strictEqual(run(['--phase', 'nope']).status, 2);
  assert.strictEqual(run([]).status, 2);
  assert.strictEqual(run(['--help']).status, 2);
  assert.strictEqual(run(['--phase', 'plan', '--bogus']).status, 2);
});

test('AC15: CC_PLUGINS_OVERLAY_DIR を既定の置き場所として読む', () => {
  const dir = mkOverlay({ 'manifest.json': MANIFEST, 'ship.md': TABLE });
  const o = json(['--phase', 'ship'], { CC_PLUGINS_OVERLAY_DIR: dir });
  assert.strictEqual(o.overlay_applied, 1);
});

test('AC16: --overlay-dir は CC_PLUGINS_OVERLAY_DIR より優先される', () => {
  const withItems = mkOverlay({ 'manifest.json': MANIFEST, 'ship.md': TABLE });
  const empty = mkOverlay({});
  const o = json(['--phase', 'ship', '--overlay-dir', empty], { CC_PLUGINS_OVERLAY_DIR: withItems });
  assert.strictEqual(o.overlay_applied, 0, '引数が env に負けてはいけない');
});

test('AC17: 7 フェーズすべてが有効な --phase 値として受理される', () => {
  const phases = ['plan', 'impl', 'test-spec', 'verify', 'qa', 'ship', 'test-model'];
  const files = { 'manifest.json': MANIFEST };
  for (const p of phases) files[`${p}.md`] = TABLE;
  const dir = mkOverlay(files);
  for (const p of phases) {
    const o = json(['--phase', p, '--overlay-dir', dir]);
    assert.strictEqual(o.overlay_applied, 1, `${p} が適用されない`);
    assert.strictEqual(o.phase, p);
  }
});

// ---------------------------------------------------------------------------
// AC18-AC21: 契約ドキュメントと消費側のドリフト検出
// ---------------------------------------------------------------------------

// 消費側が呼ぶコマンド行は契約側に正準を持つ。消費側に書いた呼び出し行を
// 「だいたい同じ」に崩せないよう、契約の節から抜いた行と byte-identical で突き合わせる。
const CONSUMERS = [
  { file: 'skills/dev-plan/SKILL.md', phase: 'plan' },
  { file: 'skills/dev-implement/SKILL.md', phase: 'impl' },
  { file: 'skills/dev-test-spec/SKILL.md', phase: 'test-spec' },
  { file: 'skills/dev-verify/SKILL.md', phase: 'verify' },
  { file: 'skills/dev-qa/SKILL.md', phase: 'qa' },
  { file: 'skills/dev-ship/SKILL.md', phase: 'ship' },
  { file: 'skills/dev-test-ledger/SKILL.md', phase: 'test-model' },
];

test('AC18: 消費側 7 ファイルすべてが qc-overlay.sh を自分のフェーズで呼ぶ', () => {
  for (const { file, phase } of CONSUMERS) {
    const md = fs.readFileSync(path.join(PLUGIN, file), 'utf8');
    const call = `qc-overlay.sh --phase ${phase}`;
    assert.ok(md.includes(call), `${file} に \`${call}\` が無い`);
  }
});

// 契約側のマーカーから正準1文を読む。テスト側に文字列を転記すると、契約だけ直したときに
// ここが古いまま通ってしまう（#56 で同型の穴を踏んでいる）。
function markedLine(md, kind) {
  const m = md.match(
    new RegExp(`<!-- qc-overlay:${kind} -->\\n([\\s\\S]*?)\\n[ \\t]*<!-- /qc-overlay:${kind} -->`),
  );
  assert.ok(m, `マーカー qc-overlay:${kind} が契約に無い`);
  const lines = m[1].split('\n').map((l) => l.trim()).filter(Boolean);
  assert.strictEqual(lines.length, 1, `qc-overlay:${kind} は1行であるべき`);
  return lines[0];
}

test('AC19: 消費側 7 ファイルすべてが報告義務の正準1文を byte-identical で持つ', () => {
  // 部分一致・語の存在チェックでは極性を守れない。実測: `/報告する/` を節より後ろの全文に
  // 当てる実装だったとき、義務の1文を「よしなにやる」に置き換えても 7 消費側のうち
  // 4 つ（dev-ship / dev-verify / dev-implement / dev-test-spec）が素通りした。
  // 長い SKILL.md には「報告する」が他所に何度も出るため、語の存在では何も守れない。
  const REPORT_LINE = markedLine(fs.readFileSync(CONTRACT, 'utf8'), 'report-line');
  for (const { file } of CONSUMERS) {
    const md = fs.readFileSync(path.join(PLUGIN, file), 'utf8');
    assert.ok(
      md.includes(REPORT_LINE),
      `${file} が報告義務の正準1文を持っていない（契約側と byte-identical であること）`,
    );
    assert.ok(
      md.includes('overlay_applied'),
      `${file} が overlay_applied に言及していない（present で分岐すると空雛形を見逃す）`,
    );
  }
});

// 組織固有の資産が dev-flow に戻ってくるのを、社名や特定ファイル名を書かずに検出する。
// denylist（「この名前のファイルが無いこと」）だと、別の名前で置かれた瞬間に素通りする。
// allowlist にしておけば、ここに無いファイルが `_shared/reference/` に現れた時点で落ちる。
const ALLOWED_REFERENCES = [
  'advisor-policy.md',
  'core-flow.md',
  'handover-template.md',
  'qc-overlay.md',
  'requirement-elicitation.md',
  'scope-discipline.md',
  'size-tier-conf.md',
  'subagent-output-contract.md',
  'test-tier-model.md',
];

test('AC20: _shared/reference/ は allowlist のファイルだけを持つ', () => {
  const dir = path.join(SHARED, 'reference');
  const actual = fs.readdirSync(dir).filter((n) => fs.statSync(path.join(dir, n)).isFile()).sort();
  assert.deepStrictEqual(
    actual,
    [...ALLOWED_REFERENCES].sort(),
    '共有リファレンスが増減している。組織固有の観点を置くなら overlay 側へ。'
      + '汎用リファレンスを正しく足したなら ALLOWED_REFERENCES も更新する',
  );
});

test('AC20b: dev-flow が overlay ディレクトリを同梱していない', () => {
  // overlay の置き場所は ~/.cc-plugins/overlay/qc/ であって plugin の中ではない。
  // plugin に overlay/ が出現したら、組織固有の観点が公開 plugin に同梱されたということ。
  const found = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      if (e.name === 'node_modules') continue;
      if (e.name === 'overlay') found.push(path.relative(PLUGIN, path.join(d, e.name)));
      else walk(path.join(d, e.name));
    }
  };
  walk(PLUGIN);
  assert.deepStrictEqual(found, [], 'overlay は plugin に同梱しない');
});

test('AC21: 契約から overlay_applied を採る理由の節が消えていない', () => {
  // この節が消えると、次に触る人が present で分岐させる方向へ戻る。
  const body = section(
    fs.readFileSync(CONTRACT, 'utf8'),
    '## 判定材料を `overlay_present` ではなく `overlay_applied` にしている理由',
  );
  assert.ok(body, '理由の節が見つからない');
  assert.ok(body.includes('空の雛形を置いた時点で警告が消える'), '空雛形の穴の記述が消えている');
  assert.ok(body.includes('conf_applied'), '同型である assess-change-size.sh への参照が消えている');
});
