#!/usr/bin/env node
'use strict';

// SKILL.md の対応表が assess-change-size.sh の実出力とズレていないかを検証する。
// 実行: node --test plugins/dev-flow/skills/_shared/scripts/skill-md-gate-tables.test.js
//
// なぜ必要か:
//   dev-implement/SKILL.md と dev-self-review/SKILL.md に書かれたゲートの対応表は、
//   assess-change-size.sh の実出力を人手で「転記」したもの。スクリプト側の閾値・配列・
//   パターンが将来変わっても、SKILL.md の表は自動では追随しない。表だけ古くなっても
//   テストは緑のままで、LLM は古い表を読んで動く（＝無音のドリフト）。
//
//   assess-change-size.test.js にも SELF_REVIEW_S / SELF_REVIEW_ML の定数があるが、
//   あれはスクリプトの配列を JS 側に写した「ミラー」なので、両方を書き換えれば通る。
//   このファイルは写しではなく **SKILL.md というドキュメントそのものを読んで**
//   スクリプトの実出力と突き合わせるので、片方だけ直したときに必ず落ちる。
//
// 落ちたときの直し方:
//   スクリプトを意図的に変えたなら SKILL.md の表を直す。表が正ならスクリプトを直す。
//   どちらが正かは assess-change-size.sh 本体と assess-change-size.test.js で決める。

const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 節の切り出しは e2e-test-generator.test.js と共有する。複製すると片方だけ直したときに
// 節境界の欠陥（コードフェンス内の `#` を見出しと誤認する）がもう片方で復活する。
const { section } = require('./md-section.js');

const SCRIPT = path.join(__dirname, 'assess-change-size.sh');
const SKILLS_DIR = path.join(__dirname, '..', '..');
const DEV_IMPLEMENT_MD = path.join(SKILLS_DIR, 'dev-implement', 'SKILL.md');
const DEV_SELF_REVIEW_MD = path.join(SKILLS_DIR, 'dev-self-review', 'SKILL.md');
const DEV_SHIP_MD = path.join(SKILLS_DIR, 'dev-ship', 'SKILL.md');
const DEV_QA_MD = path.join(SKILLS_DIR, 'dev-qa', 'SKILL.md');
const DEV_VERIFY_MD = path.join(SKILLS_DIR, 'dev-verify', 'SKILL.md');

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

// 各サイズ帯の代表行数。閾値（100 / 500）そのものの検証は assess-change-size.test.js の
// AC1b が持つので、ここは「帯の代表点」で十分。
const SIZE_LINES = { S: 50, M: 200, L: 700 };
// リスク HIGH を踏むパス。既定パターン **/api/** に当たる。
const RISK_PATH = { LOW: 'src/plain.ts', HIGH: 'src/api/users.ts' };

function realGates(t, size, risk, extraArgs = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-table-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const git = (args) => execFileSync('git', args, { cwd: dir, env: GIT_ENV, encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.name', 't']);
  git(['config', 'user.email', 't@t']);

  const rel = RISK_PATH[risk];
  fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), '');
  git(['add', '-A']);
  git(['commit', '-qm', 'base']);
  const base = git(['rev-parse', 'HEAD']).trim();

  const body = Array.from({ length: SIZE_LINES[size] }, (_, i) => `line ${i}`).join('\n') + '\n';
  fs.writeFileSync(path.join(dir, rel), body);
  git(['add', '-A']);
  git(['commit', '-qm', 'change']);
  const head = git(['rev-parse', 'HEAD']).trim();

  const out = execFileSync('bash', [SCRIPT, '--dir', dir, '--base', base, '--head', head, ...extraArgs], {
    cwd: os.tmpdir(),
    env: GIT_ENV,
    encoding: 'utf8',
  });
  const json = JSON.parse(out);

  // fixture が意図した帯に落ちていることを先に確かめる。ここがズレていると
  // 以降の比較が「別の帯どうしの比較」になり、検証が意味を失う。
  assert.equal(json.size, size, `fixture が ${size} 帯に落ちていない`);
  assert.equal(json.risk, risk, `fixture が ${risk} に落ちていない`);
  return json.gates;
}

// --- dev-implement/SKILL.md: 6行の判定 → adversarial_lenses 表 -----------------

// 例: `   | S × LOW | `["A"]` | A の1本 |`（節内の箇条書きの下にあるのでインデントあり）
const LENS_ROW = /^\s*\|\s*([SML])\s*×\s*(LOW|HIGH)\s*\|\s*`(\[[^`]*\])`\s*\|/;

function parseLensTable(md) {
  const rows = new Map();
  for (const line of md.split('\n')) {
    const m = LENS_ROW.exec(line);
    if (m) rows.set(`${m[1]}×${m[2]}`, JSON.parse(m[3]));
  }
  return rows;
}

test('dev-implement/SKILL.md のレンズ対応表が判定器の実出力と一致する', (t) => {
  const table = parseLensTable(fs.readFileSync(DEV_IMPLEMENT_MD, 'utf8'));

  assert.equal(
    table.size,
    6,
    'SKILL.md から 6 行（S/M/L × LOW/HIGH）を読み取れなかった。' +
      '表の書式が変わったならこのテストの LENS_ROW も直すこと（表が消えた場合も落ちる）',
  );

  for (const size of ['S', 'M', 'L']) {
    for (const risk of ['LOW', 'HIGH']) {
      const key = `${size}×${risk}`;
      const gates = realGates(t, size, risk);
      assert.deepEqual(
        table.get(key),
        gates.adversarial_lenses,
        `${key}: SKILL.md の表と判定器の実出力がズレている（SKILL.md=${JSON.stringify(table.get(key))} / 実出力=${JSON.stringify(gates.adversarial_lenses)}）`,
      );
    }
  }
});

// --- dev-self-review/SKILL.md: エージェント表の S / M・L 列 --------------------

// 例: `| `dev-flow:Code-Reviewer` | コード品質… | .agent/… | ✅ | ✅ |`
const MEMBER_ROW = /^\|\s*`(dev-flow:[A-Za-z-]+)`\s*\|[^|]*\|[^|]*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|/;

function parseMemberTable(md) {
  const s = [];
  const ml = [];
  for (const line of md.split('\n')) {
    const m = MEMBER_ROW.exec(line);
    if (!m) continue;
    const [, name, sCell, mlCell] = m;
    if (sCell.startsWith('✅')) s.push(name);
    if (mlCell.startsWith('✅')) ml.push(name);
  }
  return { s, ml };
}

test('dev-self-review/SKILL.md のメンバー表が判定器の self_review_members と一致する', (t) => {
  const table = parseMemberTable(fs.readFileSync(DEV_SELF_REVIEW_MD, 'utf8'));

  assert.ok(
    table.ml.length >= 3,
    'SKILL.md からエージェント表を読み取れなかった。表の書式が変わったならこのテストの MEMBER_ROW も直すこと',
  );

  // 表は「起動する顔ぶれ」を定義するもので、並び順の規約は判定器側（契約 §6）が持つ。
  // 集合として比較する。
  const sortedOf = (gates) => [...gates.self_review_members].sort();

  assert.deepEqual(
    [...table.s].sort(),
    sortedOf(realGates(t, 'S', 'LOW')),
    'S 列の ✅ と判定器の self_review_members（S）がズレている',
  );
  assert.deepEqual(
    [...table.ml].sort(),
    sortedOf(realGates(t, 'M', 'LOW')),
    'M・L 列の ✅ と判定器の self_review_members（M）がズレている',
  );
  assert.deepEqual(
    sortedOf(realGates(t, 'M', 'LOW')),
    sortedOf(realGates(t, 'L', 'LOW')),
    'M と L で self_review_members が違う。SKILL.md は両者を「M・L」の1列で表現しているので、' +
      '分岐させるなら表も2列に分けること',
  );
});

// --- 自己検証モデルの表（dev-implement のレンズ表 / dev-self-review の自己検証列）-----------
//
// 判定器の --main-model 分岐を人手で転記した表なので、既存の表と同じく実出力と突き合わせる。

const SV_ARGS = ['--main-model', 'claude-opus-5[1m]'];
const SV_LENS_ROW = /^\s*\|\s*自己検証\s*×\s*(LOW|HIGH)\s*\|\s*`(\[[^`]*\])`\s*\|/;

test('dev-implement/SKILL.md の自己検証レンズ表が判定器の実出力（全サイズ）と一致する', (t) => {
  const rows = new Map();
  for (const line of fs.readFileSync(DEV_IMPLEMENT_MD, 'utf8').split('\n')) {
    const m = SV_LENS_ROW.exec(line);
    if (m) rows.set(m[1], JSON.parse(m[2]));
  }
  assert.equal(rows.size, 2, '自己検証 × LOW/HIGH の2行を読み取れなかった');
  for (const size of ['S', 'M', 'L']) {
    for (const risk of ['LOW', 'HIGH']) {
      const gates = realGates(t, size, risk, SV_ARGS);
      assert.deepEqual(rows.get(risk), gates.adversarial_lenses, `${size}×${risk}（自己検証）: 表と実出力がズレている`);
    }
  }
});

test('dev-self-review/SKILL.md の自己検証列が判定器の self_review_members と一致する', (t) => {
  const s = [];
  const ml = [];
  for (const line of fs.readFileSync(DEV_SELF_REVIEW_MD, 'utf8').split('\n')) {
    const m = /^\|\s*`(dev-flow:[A-Za-z-]+)`\s*\|[^|]*\|[^|]*\|[^|]*\|[^|]*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|/.exec(line);
    if (!m) continue;
    if (m[2].startsWith('✅')) s.push(m[1]);
    if (m[3].startsWith('✅')) ml.push(m[1]);
  }
  assert.ok(s.length >= 1, '自己検証列を読み取れなかった。表の列構成が変わったならこの正規表現も直すこと');
  const sorted = (g) => [...g.self_review_members].sort();
  assert.deepEqual([...s].sort(), sorted(realGates(t, 'S', 'LOW', SV_ARGS)), 'S（自己検証）列がズレている');
  assert.deepEqual([...ml].sort(), sorted(realGates(t, 'M', 'LOW', SV_ARGS)), 'M・L（自己検証）列がズレている');
  assert.deepEqual(sorted(realGates(t, 'M', 'LOW', SV_ARGS)), sorted(realGates(t, 'L', 'LOW', SV_ARGS)), 'M と L で自己検証の顔ぶれが違う');
});

test('ゲートを消費する判定器の呼び出しがすべて --main-model を渡している', () => {
  // 付け忘れても重い側（standard）に倒れるだけで壊れはしないが、その呼び出しでは軽量化が効かない。
  // dev-setup の呼び出しは較正の警告を見るだけで gates を使わないので対象外。
  const expected = { [DEV_IMPLEMENT_MD]: 3, [DEV_SELF_REVIEW_MD]: 1, [DEV_SHIP_MD]: 1 };
  for (const [file, n] of Object.entries(expected)) {
    const calls = fs.readFileSync(file, 'utf8').split('\n').filter((l) => /^\s*bash \S*assess-change-size\.sh /.test(l));
    assert.equal(calls.length, n, `${path.basename(path.dirname(file))}: 判定器の呼び出し行が ${n} 行ではない`);
    for (const c of calls) {
      assert.match(c, / --main-model <このセッションのモデル ID>$/, `${path.basename(path.dirname(file))}: --main-model が無い呼び出し: ${c.trim()}`);
    }
  }
});

// --- gates のキーに消費側が存在すること（契約 §2「消費側の明記」）-----------------
//
// 判定器にゲートのキーを足しても、消費側の SKILL.md が言及していなければ
// 「判定はされているが誰も見ていない」ゲートが無音で生まれる（実際に §3 の qa ゲートは
// Issue 本文にありながら Phase 1〜4 のどの実装にも接続されていなかった）。
//
// dev-ship / dev-implement はどちらも「この節で使う」か「ship 側／implement 側のゲートなので
// 使わない」を明記する規約になっているので、**両方のファイルに全キーが登場する**ことを要求する。
// 表の書式には依存しない（inline code として現れれば可）ので、表を組み替えても壊れない。
//
// ⚠ **このテストが保証するのは「言及の有無」だけ**。キーが書いてあるのに手順の記述が実挙動と
// ズレているケース（例: E0.7 が見る qa-report のパスが実際と違う）は拾えない。
// 手順内容の検証は dogfood（受け入れ条件7）の担当で、機械テストの範囲外。

test('gates の全キーが dev-ship / dev-implement の SKILL.md に登場する（消費側の欠落を検出）', (t) => {
  const keys = Object.keys(realGates(t, 'S', 'LOW'));
  assert.ok(keys.length >= 6, '判定器から gates を読み取れなかった');

  for (const [label, file] of [
    ['dev-ship', DEV_SHIP_MD],
    ['dev-implement', DEV_IMPLEMENT_MD],
  ]) {
    const md = fs.readFileSync(file, 'utf8');
    for (const key of keys) {
      assert.ok(
        md.includes(`\`${key}\``) || md.includes(`\`gates.${key}\``),
        `${label}/SKILL.md が gates.${key} に一切言及していない。` +
          '消費するなら手順に組み込み、使わないなら「使わない」側の列挙に足すこと' +
          '（言及が無いキーは「判定されているが誰も見ていないゲート」になる）',
      );
    }
  }
});

// --- 強制点そのものが消えていないか（アンカーの存在）----------------------------
//
// 上のテストは「キー名がどこかに書いてあるか」しか見ない。実測では、`dev-ship/SKILL.md` から
// **E0.7 節を丸ごと削除**して残った言及を E0.5 のゲート表1行だけにしても 3/3 pass した。
// E0.7 は契約 §6 が「強制点は dev-ship の E0.7 だけ」と明記した唯一の強制点で、
// これが消えると Phase 5 の成果物は「判定はするが誰も止めない」に戻る。
//
// また dev-ship は「WHY の全文は dev-qa/SKILL.md にある」と外部参照する設計なので、
// 参照先が消えても気づけないのは片手落ち。参照先も検査対象に含める。
const GATE_ANCHORS = [
  {
    key: 'qa',
    file: DEV_SHIP_MD,
    label: 'dev-ship',
    anchors: ['### E0.7', 'qa-report'],
    why: 'qa ゲートの唯一の強制点（契約 §6）。E0.7 が消えると判定はされるが誰も止めない',
  },
  {
    key: 'qa',
    file: DEV_QA_MD,
    label: 'dev-qa',
    anchors: ['gates.qa'],
    why: 'dev-ship E0.7 が「理由の全文はここ」と外部参照している参照先',
  },
  {
    key: 'code_reviewer',
    file: DEV_IMPLEMENT_MD,
    label: 'dev-implement',
    anchors: ['Step 3'],
    why: 'code_reviewer の分岐先',
  },
];

test('ゲートの強制点（節アンカー）が消えていない', (t) => {
  const keys = Object.keys(realGates(t, 'S', 'LOW'));

  // 表が空・anchors が空だと 0アサーションで pass する（PRODUCER_ANCHORS と同型）。
  assert.ok(GATE_ANCHORS.length >= 3, `GATE_ANCHORS が ${GATE_ANCHORS.length} 件しかない`);

  for (const { key, file, label, anchors, why } of GATE_ANCHORS) {
    assert.ok(anchors.length > 0, `GATE_ANCHORS の ${key}/${label} に anchors が無い`);
    assert.ok(keys.includes(key), `gates に ${key} が無い。アンカー表が判定器とズレている`);
    const md = fs.readFileSync(file, 'utf8');
    for (const anchor of anchors) {
      assert.ok(
        md.includes(anchor),
        `${label}/SKILL.md から「${anchor}」が消えている（gates.${key} の消費側）。${why}`,
      );
    }
  }
});

// --- 較正テンプレートのパスが判定器と dev-setup で一致しているか（Issue #44 問題1）--------
//
// 判定器は「テンプレートがあるのに conf が有効でない」を警告し、dev-setup B1-3.5 は
// そのテンプレートを worktree の .agent/ へコピーする。**両者は同じパスを指していなければ
// 意味がない。** ズレると「警告は鳴るがコピー先が違う」「コピーしても警告が消えない」
// という、どちらも無音で人を消耗させる状態になる。
//
// 片方だけを直したときに必ず落ちるよう、スクリプトから定数を**実際にパースして**
// SKILL.md の記述と突き合わせる（JS 側に転記するとミラーになって両方直せば通ってしまう）。

const DEV_SETUP_MD = path.join(SKILLS_DIR, 'dev-setup', 'SKILL.md');
const ASSESS_SCRIPT = path.join(__dirname, 'assess-change-size.sh');

test('較正テンプレートのパスが判定器と dev-setup B1-3.5 で一致している', () => {
  const script = fs.readFileSync(ASSESS_SCRIPT, 'utf8');
  const m = script.match(/^CONF_TEMPLATE_PATH="([^"]+)"/m);
  assert.ok(m, 'assess-change-size.sh に CONF_TEMPLATE_PATH の定義が無い');
  const templatePath = m[1];

  const md = fs.readFileSync(DEV_SETUP_MD, 'utf8');
  assert.ok(
    md.includes('#### B1-3.5'),
    'dev-setup/SKILL.md から B1-3.5（較正テンプレートの適用）が消えている。' +
      '判定器の警告だけが残ると、警告を消す手段が手順書に無い状態になる',
  );
  // ⚠ whole-file の includes にしないこと。実測では B1-3.5 の -f と cp を
  //    `.agent/size-tier.conf.template`（設計が明示的に禁じている置き場＝同じ理由で消える）
  //    に変えても、echo 行に残った正しいパスがマッチして 6/6 pass だった。
  //    実際にコピー元を決めているのは条件式と cp の2行なので、その2行を検査する。
  //
  // ⚠ 節の切り出しに `md.slice(md.indexOf(A), md.indexOf(B))` を使わないこと。
  //    Issue #45 Phase 3 で `#### B1-3.6.` を B1-3.5 と `### B2.` の間に増設したところ、
  //    「B1-3.5 節」が 960 → 3,595 文字に膨らみ、B1-3.6 側の行で assert が満たされる
  //    ようになった（実測: B1-3.5 の上書き防止ガードを外しても 8/8 pass のまま無検知）。
  //    次の同レベル以上の見出しで正しく止まる section()（md-section.js）を使う。
  const b1_3_5 = section(md, '#### B1-3.5.');
  assert.ok(b1_3_5.length > 200, 'B1-3.5 節の切り出しに失敗した');
  assert.ok(
    !b1_3_5.includes('B1-3.6'),
    'B1-3.5 節の切り出しに B1-3.6 の内容が混入している（節境界が突き抜けている）',
  );
  assert.ok(
    new RegExp(`\\[ -f ${templatePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\]`).test(b1_3_5),
    `B1-3.5 の存在チェックが判定器と違うパスを見ている。判定器: ${templatePath}`,
  );
  assert.ok(
    new RegExp(`cp ${templatePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\.agent/size-tier\\.conf`).test(b1_3_5),
    `B1-3.5 の cp が「${templatePath} → .agent/size-tier.conf」になっていない`,
  );
  // 「conf が既にあるならテンプレートで上書きしない」の条件。B1-3 で main clone から
  // 写した較正（プロジェクトで育てたもの）をテンプレートで潰さないための順序が仕様。
  assert.ok(
    /!\s*-e\s+\.agent\/size-tier\.conf/.test(b1_3_5),
    'B1-3.5 に「conf がまだ無いときだけコピーする」条件が無い。' +
      'B1-3 で main clone から写した較正をテンプレートで上書きしてしまう',
  );
});

// --- producer 手順の強制点（Issue #45 Phase 3・4）----------------------------------
//
// GATE_ANCHORS は各エントリで `assert.ok(keys.includes(key))`（アンカーが gates の実キーに
// 対応すること）を要求する。しかし B1-3.6（docs/testing/size-tier.conf.template を作る手順）や
// D4.6（test:e2e:core を作る手順）は「較正テンプレート／コア E2E スクリプトという**成果物**を
// 生成する producer」であって、assess-change-size.sh の gates に対応するキーを持たない
// （gates は「何を起動するか」の決定であって、「誰がテンプレートを作るか」はその外側）。
// GATE_ANCHORS に相乗りさせると存在しないキーの assert が常に落ちるため、
// producer 用の別表を立てる。Phase 4 で D4.6 のエントリを追加できるよう、
// 表の形（file / label / anchors / why）は GATE_ANCHORS と揃えてある。
const PRODUCER_ANCHORS = [
  {
    id: 'size-tier-conf-template-producer',
    file: DEV_SETUP_MD,
    label: 'dev-setup',
    anchors: ['#### B1-3.6.'],
    why:
      'docs/testing/size-tier.conf.template を作る唯一の producer（Issue #45 Phase 3・AC6）。' +
      'この見出しが消えると、テンプレートを対話で生成する手順が dev-flow のどこにも無い状態に戻る' +
      '（判定器側の「較正が効いていない」警告は鳴り続けるが、直しに戻る先が無い）',
  },
  {
    // Issue #45 Phase 3 敵対的検証 B M-8: hub-run-add.mjs（dev-hub の実行履歴ビューが
    // 動画を表示する唯一の経路）を呼ぶ producer が11スキル・17ヒットあるのに、
    // このテストのヒットは0件だった。QA 側のアンカーをここに足す。
    id: 'hub-run-add-dev-qa',
    file: DEV_QA_MD,
    label: 'dev-qa',
    anchors: ['### Q7.5.', 'hub-run-add.mjs'],
    why:
      'dev-hub の実行履歴ビューに QA 証跡を束ねる producer（B M-8）。' +
      'この見出しが消えると QA 成果物が dev-hub の実行履歴から無音で欠落する',
  },
  {
    // 上と同じ producer ファミリの verify 側。
    id: 'hub-run-add-dev-verify',
    file: DEV_VERIFY_MD,
    label: 'dev-verify',
    anchors: ['### D7.5.', 'hub-run-add.mjs'],
    why:
      'dev-hub の実行履歴ビューに verify 成果物（E2E 動画・レポート）を束ねる producer（B M-8）。' +
      'この見出しが消えると verify 成果物が dev-hub の実行履歴から無音で欠落する',
  },
  {
    // Issue #45 Phase 4: dev-ship E1.2（`gates` に対応するキーを持たない実行ゲート）が
    // 前提とする `test:e2e:core` の定義先が dev-flow のどこにも無かった（#44 v0.43.0 の申し送り）。
    id: 'test-e2e-core-producer',
    file: DEV_VERIFY_MD,
    label: 'dev-verify',
    anchors: ['### D4.6.'],
    why:
      '`package.json` に `test:e2e:core` を定義する唯一の producer（Issue #45 Phase 4・AC7）。' +
      'この見出しが消えると、dev-ship E1.2 が「未定義のためスキップ」を出し続ける原因（定義する' +
      '手順がどこにも無いこと）が再び dev-flow 全体から消滅する',
  },
];

test('producer 手順（gates の実キーに対応しない見出し）が消えていない', () => {
  // ⚠ 件数ガード必須。実測: PRODUCER_ANCHORS = [] でも anchors: [] でも
  //    0アサーションのまま pass する（Issue #45 Phase 3 敵対的検証 B m-2）。
  //    表を空にする／エントリを削る変異が「テストは全部緑」で素通りしないよう、
  //    件数そのものを検査対象にする。
  assert.ok(
    PRODUCER_ANCHORS.length >= 4,
    `PRODUCER_ANCHORS が ${PRODUCER_ANCHORS.length} 件しかない（4件未満）。` +
      'エントリが誤って削られていないか確認すること（0アサーションで pass する事故を防ぐガード）',
  );
  for (const { id, file, label, anchors, why } of PRODUCER_ANCHORS) {
    assert.ok(id, 'PRODUCER_ANCHORS の各エントリに id が無い（どのエントリが落ちたか特定できなくなる）');
    const md = fs.readFileSync(file, 'utf8');
    for (const anchor of anchors) {
      assert.ok(
        md.includes(anchor),
        `[${id}] ${label}/SKILL.md から「${anchor}」が消えている。${why}`,
      );
    }
  }
});

// --- B1-3.6 の手順本文そのもの（Issue #45 Phase 3 敵対的検証 U-2 / Critical）----------
//
// 上の PRODUCER_ANCHORS は「見出しが存在するか」しか見ない。実測では見出しと
// ```conf フェンスさえ残せば手順54行を全部消しても全 pass だった。発火条件・
// B1-3.5 優先順位ガード・AskUserQuestion の2択・生成物の扱いが無検査のまま
// だったので、挙動を決めている行そのものを字面で固定する。
//
// ⚠ 語の存在チェックにしないこと。この節のうち後半6行（生成物の扱い・失効判定の
// 見方）は Issue #45 Phase 3 の時点ではまだ実装されておらず、このテストは
// その分だけ RED になる（実装側が追加するまで失敗し続けるのが正しい状態）。
const B1_3_6_REQUIRED_LINES = [
  {
    key: '発火条件',
    line: '- **発火条件**: `docs/testing/size-tier.conf.template` が**存在しないリポジトリ**のときだけ。',
    why: 'テンプレートが既にあるリポジトリで無条件に対話が走ると、B1-3.5 で足りるケースまで毎回ヒアリングが挟まる',
  },
  {
    key: 'B1-3.5優先順位（極性）',
    line: 'ここで生成したテンプレートで**上書きしない**。`docs/` 配下への書き出しはこの条件と無関係に行う',
    why: '極性反転（上書きしない→上書きする）は、B1-3 で main clone から写した「プロジェクトで育てた較正」を' +
      '対話生成のテンプレートで潰す。#44 が明示的に守りに入れた順序の反転',
  },
  {
    key: 'AskUserQuestion の2択',
    line: '`AskUserQuestion` で「テンプレートを生成する / 生成しない（既定値のまま',
    why: '対話を経ずに常に生成する/しないへ倒れると、「既定値で妥当なリポジトリでも毎回生成」' +
      'または「較正が必要なリポジトリでも生成しない」のどちらかに固定化される',
  },
  {
    key: '記法ドキュメント案内',
    line: '**記法は `skills/_shared/reference/size-tier-conf.md` を参照する**',
    why: '記法を参照せず対話生成すると、`load_conf()` が行番号だけを警告に出して黙って無視する書式違反を' +
      '踏みやすくなる（Issue #45 Phase 3 敵対的検証 A M-2 と同型）',
  },
  {
    key: '生成しない選択の無音化警告',
    line: '> ⚠ **「生成しない」を選ぶと、以後この較正が効いていないことを知らせる音はどこからも鳴らない。**',
    why: '「既定値で妥当と判断した」と「誰も較正を検討していない」が出力上まったく同じになる' +
      '（Issue #45 Phase 3 敵対的検証 U-3。#44 が塞いだ「無音で較正が効いていない」と同型の再発）',
  },
  {
    key: '生成物の単独コミット',
    line: '- **生成したら `git add docs/testing/size-tier.conf.template` して単独コミットする**（untracked のままだと worktree を消したときに一緒に消え、「tracked で残す」という目的が達成されない）',
    why: 'commit しないまま worktree を消すと、生成した較正テンプレートごと消え「tracked で残す」目的が' +
      '達成されない（Issue #45 Phase 3 敵対的検証 U-8）',
  },
  {
    key: '既存 conf を出発点にする',
    line: '- **`.agent/size-tier.conf` が既にあるなら、その内容を出発点にする**（新規に書き起こすと tracked テンプレートと実際の較正が乖離し、以後の全 worktree に乖離した方が配られる）',
    why: '新規に書き起こすと、育った較正と新しく作るテンプレートが乖離し、以後の全 worktree に' +
      '乖離した方が配られる（Issue #45 Phase 3 敵対的検証 B M-1）',
  },
  {
    key: '緩和方向の警告は許容',
    line: '- **`既定を緩めている` の警告は出てよい**（exclude の追加・閾値の引き上げは緩和方向なので必ず鳴る仕様）。ここで見るのは `docs/testing/size-tier.conf.template` を含む警告が消えたことだけ',
    why: 'この2つの警告を区別せず「警告が消えたことを確認する」とだけ書くと、緩和方向の警告が常に鳴る' +
      '既定パターンで合格条件が事実上成立しない（Issue #45 Phase 3 敵対的検証 U-7）',
  },
  {
    key: '解釈できなかった警告での再実行',
    line: '- **`解釈できなかった` を含む警告が1件でもあれば、書式を直してから再実行する**（警告は20件で打ち切られるため、解釈不能行が多いと較正警告そのものが省略されて偽の緑になる）',
    why: '記法違反（`threshold_m = 150` のような空白混入・行末コメント）は既定の合格条件では' +
      '検出されず素通りする（Issue #45 Phase 3 敵対的検証 A M-2）',
  },
  {
    key: 'setup時点でlines:0が正常',
    line: '- setup 時点では差分がまだ無いので `lines:0` が正常。ここで見るのは `warnings` だけ',
    why: 'dev-implement Step 0.6 の「`lines:0` は中断」という契約と字面が一致するため、読み手が' +
      '矛盾する2つの指示に晒される（Issue #45 Phase 3 敵対的検証 B m-5）',
  },
];

// 手順本文の pin 表を検証する共通ヘルパー。B1-3.6（Phase 3）と D4.6（Phase 4）で
// 5ステップの同じ構造を書いていたが、このリポジトリは過去に同型の複製（`section()` の
// バイト単位コピー）で「片方だけ直して欠陥が復活する」事故を出し `md-section.js` に
// 一本化した経緯がある。同じパターンを2度作らない。
//
// 件数は**実件数ちょうど**を要求する（`>=` の緩いガードは、実10件に対し `>= 8` だと
// 2件まで削っても落ちない＝検出漏れそのものになる）。
function assertRequiredLines(mdPath, heading, table, tableName, expectedCount) {
  const md = fs.readFileSync(mdPath, 'utf8');
  const body = section(md, heading);
  assert.ok(body.length > 200, `${heading} 節の切り出しに失敗した`);

  assert.equal(
    table.length,
    expectedCount,
    `${tableName} が ${table.length} 件（期待${expectedCount}件）。` +
      '件数がズレるとこのガード自体が実効性を失う（緩めても落ちない／減らしても検知しない）',
  );

  const missing = [];
  for (const { key, line, why } of table) {
    if (!body.includes(line)) missing.push(`[${key}] 「${line}」が無い — ${why}`);
  }
  assert.deepStrictEqual(
    missing, [],
    `${heading} の手順本文から挙動を決めている行が欠けている:\n` + missing.join('\n'),
  );
}

test('AC66: B1-3.6 の手順本文の挙動を決めている行が字面どおりに残っている', () => {
  assertRequiredLines(DEV_SETUP_MD, '#### B1-3.6.', B1_3_6_REQUIRED_LINES, 'B1_3_6_REQUIRED_LINES', 10);
});

test('B1-3.6 の生成手順（step 5）が no-op 経路で exit 1 を返す旧形式に戻っていない', () => {
  // 実測: `[ ! -e .agent/size-tier.conf ] && mkdir -p .agent && \` は
  // conf が既にある正常な no-op 経路で exit 1 を返す（#44 の E1.2 `A && B || C` と
  // 同じファミリの欠陥）。B1-3.5 の if...fi と同じ形に直すことが Issue #45 Phase 3
  // 敵対的検証 U-6 / C M-4 の是正内容なので、新形式の存在と旧形式の不在を両方 assert する
  // （新形式だけ足して旧形式を残す変異は、片方の assert だけでは検出できない）。
  const md = fs.readFileSync(DEV_SETUP_MD, 'utf8');
  const b1_3_6 = section(md, '#### B1-3.6.');

  assert.ok(
    b1_3_6.includes('cd <worktreeの絶対パス>'),
    'B1-3.6 step 5 に `cd <worktreeの絶対パス>` が無い。step 5 の書き込みは cwd 相対なので、' +
      'cwd が worktree からずれていると無音で別の場所に書き込む（Issue #45 Phase 3 敵対的検証 A M-5）',
  );
  assert.ok(
    b1_3_6.includes('if [ ! -e .agent/size-tier.conf ]; then'),
    'B1-3.6 step 5 が `if [ ! -e .agent/size-tier.conf ]; then` の形になっていない。' +
      'B1-3.5 と同じ if...fi 形式でないと、conf が既にある正常な no-op 経路で exit 1 を返す',
  );
  assert.ok(
    !b1_3_6.includes('[ ! -e .agent/size-tier.conf ] && mkdir'),
    'B1-3.6 step 5 に旧形式（`[ ! -e .agent/size-tier.conf ] && mkdir` の `&&` 連鎖）が' +
      '残っている。if...fi 形式を足しても旧形式を消していないと、どちらが実行されるか読み手に伝わらない',
  );
});

test('docs/testing/size-tier.conf.template のパスが判定器と dev-setup B1-3.6（producer）で一致している', () => {
  // B1-3.5（コピーするだけの側）には判定器の CONF_TEMPLATE_PATH との整合テストがあるのに、
  // 同じパスの唯一の producer である B1-3.6（生成する側）には無い、という非対称の是正
  // （Issue #45 Phase 3 敵対的検証 U-2 の一部）。
  const script = fs.readFileSync(ASSESS_SCRIPT, 'utf8');
  const m = script.match(/^CONF_TEMPLATE_PATH="([^"]+)"/m);
  assert.ok(m, 'assess-change-size.sh に CONF_TEMPLATE_PATH の定義が無い');
  const templatePath = m[1];
  const escaped = templatePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const md = fs.readFileSync(DEV_SETUP_MD, 'utf8');
  const b1_3_6 = section(md, '#### B1-3.6.');
  assert.ok(
    new RegExp('`' + escaped + '` に書き出す').test(b1_3_6),
    `B1-3.6 の生成手順が判定器と違うパスに書き出している（判定器: ${templatePath}）。` +
      'ズレると「対話で作ったテンプレートを判定器が見つけられない」状態になる',
  );
});

// --- コア E2E 実行ゲート（Issue #44 問題4）----------------------------------------
//
// ある業務リポジトリで E2E 55本が腐った根本原因は「誰かがローカルで回すだろう」に**機構が
// 無かった**こと（CI で回っている E2E は 0本だった）。問題2 で生成本数を減らす以上、
// 「残したコア E2E は必ず回る」機構が同じ PR に無いと、根本原因は未解決のまま残る。
//
// 強制点は dev-ship の E1.2 だけ。ここが消えると「E2E を減らしたが回してもいない」に戻る。

test('コア E2E 実行ゲート（dev-ship E1.2）の強制点が消えていない', () => {
  const md = fs.readFileSync(DEV_SHIP_MD, 'utf8');
  const e1_2 = section(md, '### E1.2');
  assert.ok(
    md.includes('### E1.2'),
    'dev-ship/SKILL.md から E1.2（コア E2E 実行ゲート）が消えている。' +
      '問題2 で E2E の生成本数を減らした以上、残したものが必ず回る機構が無いと' +
      '「減らしただけ」になる',
  );
  // ⚠ whole-file の includes にしないこと。実測では bash ブロックのスクリプト名を
  //    test:e2e:smoke に変えても、**ブロックを丸ごと削除しても** 6/6 pass だった
  //    （表や散文に残る 'test:e2e:core' がマッチするため）。実行を決めているのは
  //    この行なので、E2E_EMPTY_GUARD と同じく字面で完全一致固定する。
  const E1_2_GUARD = [
    'if node -e "process.exit(require(\'<REPO_ROOT>/package.json\').scripts?.[\'test:e2e:core\'] ? 0 : 1)" 2>/dev/null; then',
    '  npm --prefix <REPO_ROOT> run test:e2e:core; rc=$?',
  ];
  for (const line of E1_2_GUARD) {
    assert.ok(
      e1_2.includes(line),
      `E1.2 の実行式が字面どおりでない。期待する行:\n  ${line}\n` +
        '（A && B || C で書くと npm run の失敗時にもスキップのメッセージが走り、' +
        '赤い E2E が「未定義のためスキップ」として exit 0 で報告される。' +
        '<REPO_ROOT> を落とすと cwd 依存になり monorepo/worktree で無音スキップになる）',
    );
  }
  // 禁止形の検査は**コードブロックの中だけ**に当てる。節の散文には
  // 「`A && B || C` で書かないこと」という注意書きがあり、節全体に当てると
  // 注意書き自身にマッチして落ちる（説明文を検査してしまう同型の失敗）。
  const bash = (e1_2.match(/```bash\n([\s\S]*?)```/) || [])[1] || '';
  assert.ok(bash.length > 50, 'E1.2 の bash ブロックが見つからない');
  assert.ok(
    !/&&[^\n]*\|\|/.test(bash),
    'E1.2 の bash ブロックに `A && B || C` の形が現れている。B の失敗時にも C が走り、' +
      'ゲートが構造的に失敗できなくなる',
  );
  // ⚠ 節全体に対する語の有無で検査してはいけない。実測では表の行を「中断する」に反転しても、
  //    同じ節のコード例や PR 本文の例に残った同じ語がマッチして pass した（Issue #44 で
  //    3度踏んだ同型の欠陥）。挙動を決めている表の行と指示文そのものを固定する。
  assert.ok(e1_2.length > 200, 'E1.2 節の切り出しに失敗した');

  // 未定義リポでは no-op。ここが「中断」に変わると、スクリプトを持たない大半のリポで
  // ship が止まる（＝ゲートを入れたことが全リポの妨害になる）。
  assert.ok(
    /定義していない[^\n]*no-op/.test(e1_2),
    'E1.2 の分岐表に「定義していない → no-op」が無い。' +
      'スクリプト未定義のリポジトリで ship が止まる挙動になっていないか確認すること',
  );
  // ゲートの結果は「判定は失効する」節に載っていなければならない。E1.5a/E1.5b の指摘を
  // 直してコミットが増えたら、E1.2 の PASS は**修正前のコードに対する結果**になり、
  // 「直したコードは一度も E2E を通っていないのに PASS と書いてある」PR ができる。
  // E1.5b・gates.qa で2度塞いだ穴なので、新しいゲートで3度目を作らせない。
  const expiry = section(md, '#### 判定は失効する');
  assert.ok(expiry.length > 200, '「判定は失効する」節の切り出しに失敗した');
  // 節に "E1.2" の語があるかでは足りない。宣言文を消しても後続の解説行に語が残って
  // マッチする（この PR で6度踏んだ同型）。失効を宣言している一文を字面で固定する。
  assert.ok(
    expiry.includes('E1.2 のコア E2E 結果も同じ理由で失効する'),
    '「判定は失効する」節から E1.2 の失効宣言が消えている。修正コミット後に E1.2 を' +
      '再実行する規約が無いと、修正前のコードの PASS が PR 本文に転記される',
  );

  // 赤いまま ship する逃げ道と、その監査行。塞ぐのではなく記録させる設計。
  assert.ok(
    /PR 本文に理由を明記/.test(e1_2),
    'E1.2 に「赤いまま ship する場合は PR 本文に理由を明記」の指示が無い。' +
      '逃げ道を塞ぐと test:e2e:core を定義しない形で回避されるだけで、しかもその回避は' +
      '無音になる。赤いまま出したことが PR に残っていれば後から監査できる',
  );
});


// --- PR 本文の記録義務（レンズ A m-3 ＋ 生成ゼロの監査行）--------------------------
//
// E1.2 は「逃げ道を塞がず**記録させる**」設計なので、**記録側が無防備だと指示側の
// 無防備と同義**になる。実測では PR 本文の「コア E2E」2行を削除しても 19/19 pass した。
// C-0（実行式が赤を no-op に化けさせる）と重なると、誤った「未定義のためスキップ」が
// PR 本文に載り、それを検証する検査も無いので**監査そのものが不能**になる。
//
// 生成ゼロの行も同じ理由で要る。条件付き生成が「常に該当しない」に倒れても、
// E2E が security 1本だけになったことは `e2eEmpty`（total===0）では検出できない
// （security が1本あるので 0 にならない）。同じ SKILL.md が gates.qa の承認スキップと
// E1.2 の FAIL には監査行を必須にしているのに、生成ゼロだけ非対称だった。
const PR_BODY_RECORDS = [
  {
    key: 'コア E2E',
    line: '   - **コア E2E**: E1.2 の結果を1行で書く',
    why: 'E1.2 の結果が PR に残らないと、赤いまま ship したことも no-op だったことも後から区別できない',
  },
  {
    key: 'E2E 生成',
    line: '   - **E2E 生成**:',
    why: '条件付き生成が「常に該当しない」に倒れたことを検出する唯一の記録。' +
      'gates.qa / E1.2 FAIL には監査行があるのにここだけ非対称だと、削減側の failure mode が観測不能になる',
  },
];

test('PR 本文への記録義務（E2 の必須項目）が消えていない', () => {
  const md = fs.readFileSync(DEV_SHIP_MD, 'utf8');
  const e2 = section(md, '### E2. PR作成');
  assert.ok(e2.length > 200, 'E2 節の切り出しに失敗した');

  const missing = [];
  for (const { key, line, why } of PR_BODY_RECORDS) {
    if (!e2.includes(line)) missing.push(`${key}: 「${line}」が無い — ${why}`);
  }
  assert.deepStrictEqual(missing, [], 'PR 本文の必須記録が E2 から消えている:\n' + missing.join('\n'));
});

// --- test:e2e:core の producer（Issue #45 Phase 4・AC7 / AC8）----------------------
//
// #44 v0.43.0 で dev-ship E1.2（test:e2e:core の実行ゲート）を作ったが、それを**定義させる
// 手順**が dev-flow のどこにも無かった（実測: ホーム配下で test:e2e:core を定義した
// package.json は0件）。E2E を条件付き生成に減らした分（問題2）を「残したものは必ず回る」
// 機構（E1.2）で担保する設計だったのに、担保する対象を作る producer が無いままだと
// 「削減だけが先に効き、担保は誰も発火させていない」状態のまま固定化する。
//
// dev-verify D4.6 を producer として新設する。B1-3.6（Phase 3）と同じ「見出しだけでなく
// 挙動を決めている行を字面で固定する」流儀を踏襲するが、B1-3.6 と違い**本物のツールは
// 判定器ではない**。D4.6 が生成する定義を実際に消費するのは dev-ship E1.2 のシェル片
// （`scripts?.['test:e2e:core']`）なので、producer と消費側のキー名が一致しているかを
// 実パースで突き合わせる（下のテスト）。

// --- Phase 4 敵対的検証統合レポート U-1（Critical・3レンズ収束）------------------
//
// D4.6 の「producer としての極性」「発火条件」「AskUserQuestion の2択」が1行も pin
// されていなかった。1コミット前の B1-3.6（Phase 3）の pin 表は同じ3観点を既に持っている
// のに、D4.6（6キー）には無い＝同一 Issue 内で確立済みの対策が持ち越されていない
// （B1-3.6 の U-2 と同型：片側適用漏れ）。AC59 で 16 キーに拡張する。
const D4_6_REQUIRED_LINES = [
  {
    key: 'REPO_ROOTの定義',
    line: '> `<REPO_ROOT>` は対象リポジトリルートの絶対パス（`git -C <dir> rev-parse --show-toplevel` の値）。',
    why: '定義が無いと <REPO_ROOT> が cwd 相対と誤読され、monorepo/worktree で無音の書き込み先ズレを起こす' +
      '（E1.2・E0.5・E0.7 と同じ規約に揃える必要がある。統合レポート U-1）',
  },
  {
    key: '発火条件1（未定義）',
    line: '  1. `package.json` に `test:e2e:core` が**未定義**',
    why: '発火条件が非 pin だと probe のキーを差し替える変異（U-2）で producer が恒久スキップになっても検知できない',
  },
  {
    key: '発火条件2（コア導線変更時の見直し）',
    line: '  2. 定義済みでも、**この Phase でコア導線そのものを変更した**（D3-3 の条件(1) に当たった）なら**中身を見直す**',
    why: '「キーの存在」だけを no-op 判定にすると、コア導線を変えた Phase で spec を1本足しても' +
      'test:e2e:core は定義済みのため no-op に落ち、E1.2 が古いコア集合のまま緑を報告する（統合レポート U-5）',
  },
  {
    key: 'package.json不在時のno-op',
    line: '- **`package.json` が無ければ no-op**（npm プロジェクトでないリポジトリに `test:e2e:core` の概念は無い）',
    why: 'この行が消えると node 行に直行し、npm プロジェクトでないリポジトリ（Python / Go / Ansible）で' +
      'も「未定義」と判定されて定義手順に進む（AC67 の nopkg 経路が実走で固定）',
  },
  {
    key: '2>/dev/nullが消しているもの',
    line: '- **`2>/dev/null` は分岐ではなく stderr を消している。** 壊れた `package.json` では `require()` が',
    why: 'verify で実測: 2>/dev/null の有無で分岐は変わらない（どちらも「未定義」）。' +
      '旧記述は「これが無いと npm プロジェクトでないと未定義が区別できない」と書いていたが、' +
      'その区別は手前の [ ! -f ] が付けており、誤った WHY を信じると壊れた package.json が' +
      'no-op になると誤読する（#44 の「説明文が実挙動を偽る」と同型）',
  },
  {
    key: 'DBを触るかの確認',
    line: '- **DB を触るか**: この E2E が DB を読み書きするなら、`dev-ship` E1.2 が ship のたびに実行する。並行 worktree と同じ DB を共有していないかを先に確認する',
    why: 'E1.2 は ship のたびに無条件で走るため、DB を触る E2E を隔離せずに定義すると、' +
      '他 worktree が並行作業中のデータを ship のたびに掻き回す（AC8。dev-ship E1.2 の副作用注記と同型の事故）',
  },
  {
    key: 'COMPOSE_PROJECT_NAMEでの隔離確認',
    line: '- **`COMPOSE_PROJECT_NAME` で隔離されているか**: 未設定だと空 volume が新規作成され、ローカル DB を失ったように見える（`dev-setup` B3 の実測事故）',
    why: '#31/#32 で実際に踏んだ事故（B3）の再発防止策を確認する手順が producer 側に無いと、' +
      'test:e2e:core を定義した瞬間に同じ事故を踏む経路が復活する（AC8）',
  },
  {
    key: '隔離未確認時の帰結（ユーザー確認）',
    line: '- **隔離されていなければ、定義を進める前にユーザーに確認する**（黙って走らせない）',
    why: '確認項目だけ pin して帰結（黙って走らせない）が非 pin だと、実測（統合レポート U-11）どおり' +
      '「隔離されていなければユーザーに確認する」の行そのものを削っても全 pass になる',
  },
  {
    key: 'コア導線の定義への参照',
    line: '- どの spec をコアに入れるかは `skills/_shared/reference/core-flow.md` の定義に照らして選ぶ',
    why: 'コア導線の基準を参照せずに選ぶと、各リポで「コア」の粒度がばらつき、' +
      'core-flow.md（Phase 1 で確立した正準定義）と矛盾する test:e2e:core が生まれる',
  },
  {
    key: '候補ゼロ時の分岐',
    line: '- **候補が0本なら定義しない（no-op）。** 空の定義は Playwright が `No tests found` で exit 1 を返し、以後 ship のたびに E1.2 が赤くなる',
    why: 'spec が0本のときの分岐が無いと空のまま定義に進み、以後 ship のたびに E1.2 が' +
      '「未定義のためスキップ」ではなく本物の FAIL を返し続ける（統合レポート U-4）',
  },
  {
    key: 'AskUserQuestionの2択',
    line: '3. **`AskUserQuestion` で「定義する / 定義しない（既定のままで妥当）」を確認する**',
    why: '対話を経ずに常に生成する/しないへ倒れると、「較正が要らないリポでも毎回定義」または' +
      '「必要なリポでも定義しない」のどちらかに固定化される（B1-3.6 の同型 pin と揃える）',
  },
  {
    key: '定義しない選択の無音化警告',
    line: '> ⚠ **「定義しない」を選ぶと、E1.2 は永久に「未定義のためスキップ」を出し続ける。**',
    why: '「既定値で妥当と判断した」と「誰も検討していない」が出力上まったく同じになる' +
      '（B1-3.6 の U-3 と同型の無音化）',
  },
  {
    key: '判断の記録先',
    line: '- **判断と理由は D7 の引継書に必ず記録する**（記録が無いと、次の Phase の verify で同じ対話が再発する）',
    why: 'dev-verify は Phase ごとに走るため、記録先が無いと毎回再質問され、対話疲れで' +
      '「定義しない」が既定化する（統合レポート U-12。B1-3.6 の B6 引継書記録と同型）',
  },
  {
    key: '既存scriptsへの追記（骨格上書き禁止）',
    line: '4. **既存の `scripts` に1行足す**（**`package.json` の骨格ごと上書きしない**。`dependencies` など他の設定が消える）',
    why: '実例が完全な package.json 骨格のまま「対象 spec のパスだけ差し替える」注意書きしか無いと、' +
      '素直に読むとコピーで dependencies ごと消える（統合レポート U-6）',
  },
  {
    key: '既存カテゴリとの関係（部分集合）',
    line: '- **`test:e2e:core` は既存カテゴリの部分集合**であり、4本目の独立したカテゴリではない',
    why: '独立カテゴリと誤読されると、D3 の user-stories / functional / security とは別に' +
      '新規 spec を書くよう指示することになり、Issue #44 問題2 で減らした生成本数を' +
      'D4.6 が無音で押し戻す',
  },
  {
    key: '赤いときの分岐（producer側からの構造的緑化禁止）',
    line: '- **赤いときは D5 でコードを直す。落ちている spec を `test:e2e:core` から外して緑にしないこと**（producer 側から E1.2 を構造的に緑にできてしまう）',
    why: '赤いときの分岐が無いと、最も安直な緑化は「落ちている spec を test:e2e:core から外す」' +
      '＝producer 側から E1.2 を構造的に緑にできてしまう（統合レポート U-11）',
  },
  {
    key: '生成物の単独コミット（緑確認後・REPO_ROOT指定）',
    line: '- **緑を確認してから `git -C <REPO_ROOT> add package.json` して単独コミットする**（commit されていないと、定義したつもりで E1.2 は永久に「未定義のためスキップ」を出し続ける）',
    why: 'commit しないまま worktree を消すと、定義した test:e2e:core ごと消え、' +
      'E1.2 は以後もずっと no-op のまま（B1-3.6 の U-8 と同型だが、package.json は E1.2 が' +
      'ship のたびに読むため気づかれにくい）。実行前にコミットする旧手順（step5→6の順）は' +
      '一度も走らせていない定義が先にコミットされる欠陥だった（統合レポート U-4）',
  },
];

test('AC59: D4.6 の手順本文の挙動を決めている行が字面どおりに存在する（AC7 / AC8 / Phase4統合U-1,U-3〜U-6,U-11,U-12）', () => {
  assertRequiredLines(DEV_VERIFY_MD, '### D4.6.', D4_6_REQUIRED_LINES, 'D4_6_REQUIRED_LINES', 17);
});

// --- Phase 4 敵対的検証統合レポート U-2（Major・信頼度90）: probe の bash 片が無検査 ------
//
// 実測: D4.6 の発火条件 probe のキーを `test:e2e`（ほぼ全リポが定義済み）に変えると
// producer が恒久的にスキップされるのに 189/0 だった。JSON フェンス（定義例）だけをパースする
// 既存テストでは probe の bash フェンスに手が届かない。probe と E1.2（消費側）のキー名を
// **それぞれのファイルから実パースして**突き合わせる（転記ミラー禁止は既存テストの
// コメント方針を踏襲）。
//
// あわせて #44 v0.43.0 で E1.2 に適用した是正（`A && B || C` 禁止・`2>/dev/null` 必須）が
// D4.6 の probe には最初から適用されていなかった（統合レポート U-8）ので、この2点も pin する。
test('AC60: D4.6 の発火条件 probe が E1.2 と同じキーを検出し、A && B || C 形でなく 2>/dev/null を持つ', () => {
  const verifyMd = fs.readFileSync(DEV_VERIFY_MD, 'utf8');
  const d4_6 = section(verifyMd, '### D4.6.');
  assert.ok(d4_6.length > 200, 'D4.6 節の切り出しに失敗した');

  // ⚠ .match()（最初の一致）ではなく matchAll で全件抽出し、ちょうど1個であることを
  // 確認する。理由は extractB1_3_6ConfExample()（assess-change-size.test.js）と同じ:
  // 節内に発火条件の probe 以外の ```bash フェンスが紛れ込むと「どれが本物の probe か」が
  // 決まらなくなり、デコイのフェンスを拾って無検知になりうる。
  const bashFences = [...d4_6.matchAll(/```bash\n([\s\S]*?)```/g)];
  assert.ok(
    bashFences.length > 0,
    'D4.6 節に発火条件を判定する ```bash フェンスが無い',
  );
  assert.equal(
    bashFences.length,
    1,
    `D4.6 節に \`\`\`bash フェンスが ${bashFences.length} 個ある。` +
      'どれが発火条件の probe か決まらない。節内の ```bash フェンスは probe 1個だけにすること',
  );
  const probe = bashFences[0][1];

  const probeKeyMatch = probe.match(/scripts\?\.\[\s*'([^']+)'\s*\]/);
  assert.ok(
    probeKeyMatch,
    'D4.6 の probe から `scripts?.[\'...\']` のキー名をパースできなかった（fail-loud。' +
      '握りつぶすと producer と消費側の突き合わせ自体が無音で死ぬ）',
  );

  const shipMd = fs.readFileSync(DEV_SHIP_MD, 'utf8');
  const e1_2 = section(shipMd, '### E1.2');
  const e1_2KeyMatch = e1_2.match(/scripts\?\.\[\s*'([^']+)'\s*\]/);
  assert.ok(e1_2KeyMatch, 'E1.2 のシェル片から scripts キー名をパースできなかった');

  assert.equal(
    probeKeyMatch[1],
    e1_2KeyMatch[1],
    `D4.6 の probe が検出するキー（${probeKeyMatch[1]}）と E1.2 が検出するキー（${e1_2KeyMatch[1]}）が違う。` +
      'probe のキーを緩めると（例: 全リポがほぼ定義済みの `test:e2e` に変える）producer が' +
      '恒久的にスキップされるのに、E1.2 側は影響を受けないため気づけない（統合レポート U-2）',
  );

  assert.ok(
    !/&&[^\n]*\|\|/.test(probe),
    'D4.6 の probe に `A && B || C` の形が現れている。#44 v0.43.0 で E1.2 に適用した是正が' +
      'probe には最初から適用されていない（統合レポート U-8）',
  );
  assert.ok(
    probe.includes('2>/dev/null'),
    'D4.6 の probe に `2>/dev/null` が無い。壊れた package.json では `require()` が例外を投げ、' +
      'probe 自体が壊れたように見えるスタックトレースが stderr に出る（分岐は「未定義」側で変わらない。AC67 が実走で固定）',
  );
});

// --- verify フェーズ D5: probe の分岐が一度も実行されていない -------------------------
//
// AC60 は probe を「読む」だけ（キー名・`A && B || C` 不在・`2>/dev/null` 存在）で、
// **分岐そのものは実行していない**。verify の変異注入で実測: 三項演算子を `? 1 : 0` に
// 反転しても、then/else の echo を入れ替えても **194 pass のまま**だった。
// 極性が反転すると未定義リポで「定義済み」と報告され、producer が恒久スキップになる
// ＝ Issue #45 が潰そうとした「producer が無い」状態の再生産。
// フェンスを実際に bash に食わせて、4経路の出力を固定する。
function runD4_6Probe(t, repoRoot) {
  const verifyMd = fs.readFileSync(DEV_VERIFY_MD, 'utf8');
  const d4_6 = section(verifyMd, '### D4.6.');
  const bashFences = [...d4_6.matchAll(/```bash\n([\s\S]*?)```/g)];
  assert.equal(bashFences.length, 1, 'D4.6 節の ```bash フェンスが1個ではない');
  // <REPO_ROOT> はプレースホルダなので、実走時だけ fixture の絶対パスへ差し替える。
  const script = bashFences[0][1].split('<REPO_ROOT>').join(repoRoot);
  const res = require('node:child_process').spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
  });
  return { stdout: res.stdout.trim(), stderr: res.stderr, status: res.status };
}

function makeProbeFixture(t, name, contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `d46-${name}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (contents !== null) fs.writeFileSync(path.join(dir, 'package.json'), contents);
  return dir;
}

test('AC67: D4.6 の probe を実走し、4経路の分岐が仕様どおりであることを確認する', (t) => {
  const cases = [
    {
      name: 'nopkg',
      pkg: null,
      expected: 'package.json が無いため no-op',
      why: 'npm プロジェクトでないリポジトリ（Python / Go / Ansible）は node 行へ到達しない',
    },
    {
      name: 'defined',
      pkg: '{"scripts":{"test:e2e:core":"playwright test e2e/tests/security"}}',
      expected: '定義済み（コア導線を変更した Phase でなければ no-op）',
      why: '定義済みを「未定義」と誤判定すると、producer が既存定義を上書きしにいく',
    },
    {
      name: 'undefined',
      pkg: '{"scripts":{"test:e2e":"playwright test"}}',
      expected: '未定義',
      why: '未定義を「定義済み」と誤判定すると producer が恒久スキップになる（極性反転の本命）',
    },
    {
      name: 'broken',
      pkg: '{ this is not json ',
      expected: '未定義',
      why: '壊れた package.json は「未定義」側に落ちる。手順4で編集する時点で人が気づく',
    },
  ];

  for (const c of cases) {
    const dir = makeProbeFixture(t, c.name, c.pkg);
    const { stdout } = runD4_6Probe(t, dir);
    assert.equal(stdout, c.expected, `probe(${c.name}) の出力が仕様と違う。${c.why}`);
  }
});

test('AC68: D4.6 の probe は壊れた package.json でも stderr を出さない', (t) => {
  // `2>/dev/null` が実際に消しているのは require() のスタックトレースであって、分岐ではない
  // （AC67 の broken が「未定義」に落ちることで分岐不変を固定済み）。
  // これを外すと probe 自身が壊れたように見え、no-op 判定を人が誤読する。
  const dir = makeProbeFixture(t, 'broken-stderr', '{ this is not json ');
  const { stderr } = runD4_6Probe(t, dir);
  assert.equal(
    stderr,
    '',
    'D4.6 の probe が stderr を出した。`2>/dev/null` が外れると壊れた package.json で' +
      `SyntaxError のスタックトレースが出る（実測: ${stderr.split('\n')[0]}）`,
  );
});

// --- Phase 4 敵対的検証統合レポート A Minor: 見出し降格が無検知 ------------------------
//
// PRODUCER_ANCHORS の `test-e2e-core-producer` は `md.includes('### D4.6.')` で判定するが、
// これは部分文字列一致なので `#### D4.6.` に降格されても「### D4.6.」がその中に含まれるため
// 検知できない（実測 189/0）。見出しが行頭で正確にレベル3であることを行頭アンカーで固定する。
test('AC62: D4.6 見出しがレベル3のまま（#### への降格を検知する）', () => {
  const md = fs.readFileSync(DEV_VERIFY_MD, 'utf8');
  assert.ok(
    /^### D4\.6\./m.test(md),
    'dev-verify/SKILL.md に行頭 `### D4.6.`（見出しレベル3）が無い。' +
      'PRODUCER_ANCHORS の `.includes` チェックは部分文字列一致のため、' +
      '`#### D4.6.` へ降格されても検知できない（統合レポート A Minor）',
  );
});

test('D4 節（D4.5 の手前）に test:e2e:core が既存カテゴリの部分集合であるという注記がある', () => {
  const md = fs.readFileSync(DEV_VERIFY_MD, 'utf8');
  const d4 = section(md, '### D4.');
  assert.ok(d4.length > 100, 'D4 節の切り出しに失敗した');
  assert.ok(
    !d4.includes('D4.6'),
    'D4 節の切り出しに D4.6 の内容が混入している（節境界が突き抜けている。D4.5 が section() の' +
      '終端見出しとして機能していない）',
  );
  assert.ok(
    d4.includes('- **`test:e2e:core` は既存カテゴリの部分集合**であり、4本目の独立したカテゴリではない'),
    'D4 節（`npm run test:e2e:*` の一覧がある節）に「test:e2e:core は既存カテゴリの部分集合」の' +
      '注記が無い。D4.6 だけに書いて D4 の一覧を放置すると、D4 を読んだだけの読み手には' +
      'test:e2e:core が4本目の独立カテゴリに見える（AC7 の producer とその消費導線の整合）',
  );
});

test('AC61: test:e2e:core: D4.6（producer）の定義例が E1.2（消費側）の検出キーと一致している', () => {
  // ⚠ E1.2 側のスクリプト名をこのテストに転記しないこと。転記すると「両方書き換えれば
  // 通るミラー」になり、B1-3.6 で3フェーズかけて潰した失敗を再生産する。E1.2 の実際の
  // シェル片から実パースし、D4.6 が定義するキーと突き合わせる。
  const shipMd = fs.readFileSync(DEV_SHIP_MD, 'utf8');
  const e1_2 = section(shipMd, '### E1.2');
  assert.ok(e1_2.length > 100, 'E1.2 節の切り出しに失敗した');

  const keyMatch = e1_2.match(/scripts\?\.\[\s*'([^']+)'\s*\]/);
  assert.ok(
    keyMatch,
    'dev-ship E1.2 のシェル片から `scripts?.[\'...\']` のキー名をパースできなかった。' +
      'E1.2 の検出式が変わったならこの正規表現も直すこと（パース不能を空文字などで握りつぶすと、' +
      'producer との突き合わせ自体が無音で死ぬ＝fail-loud にすること）',
  );
  const consumedKey = keyMatch[1];

  const verifyMd = fs.readFileSync(DEV_VERIFY_MD, 'utf8');
  const d4_6 = section(verifyMd, '### D4.6.');
  // ⚠ AC61（Phase 4 敵対的検証 U-9 / B B-M7）: `.match()`（最初の一致）で抜き出さないこと。
  //   assess-change-size.test.js の extractB1_3_6ConfExample() が同じ理由でコメント付きの
  //   実測を残している: 節の先頭にデコイのフェンスを1個足しつつ本物を全コメントアウトすると
  //   `.exec()`/`.match()` は先頭のデコイだけを拾って全 pass した。Phase 3 で名指しで禁じた
  //   書き方が1フェーズ後の D4.6 に戻っていたので、同じ matchAll + fences.length===1 に揃える。
  const jsonFences = [...d4_6.matchAll(/```json\n([\s\S]*?)```/g)];
  assert.ok(
    jsonFences.length > 0,
    'D4.6 節に ```json フェンスの package.json 定義例が無い。npm が読める形の実例を' +
      '示さないと、対話生成の出発点が無いまま定義を書かせることになる',
  );
  assert.equal(
    jsonFences.length,
    1,
    `D4.6 節に \`\`\`json フェンスが ${jsonFences.length} 個ある。` +
      'どれが正しい実例か決まらない。節内の ```json フェンスは実例1個だけにすること（AC61）',
  );
  const jsonFenceMatch = jsonFences[0];

  let parsed;
  try {
    parsed = JSON.parse(jsonFenceMatch[1]);
  } catch (err) {
    assert.fail(
      `D4.6 の json フェンスの定義例が JSON として parse できない（${err.message}）。` +
        'npm はこの記法をそのまま package.json に書けることが前提なので、パースできない例は' +
        'コピーしても動かない',
    );
  }
  assert.ok(
    parsed && typeof parsed.scripts === 'object' && parsed.scripts !== null,
    'D4.6 の json 定義例に `scripts` オブジェクトが無い',
  );
  assert.ok(
    Object.prototype.hasOwnProperty.call(parsed.scripts, consumedKey),
    `D4.6 の定義例の scripts に「${consumedKey}」が無い（実際の scripts: ` +
      `${JSON.stringify(Object.keys(parsed.scripts))}）。producer（D4.6）と消費側（E1.2）の` +
      'キー名がズレると、E1.2 は永久に「未定義のためスキップ」を出し続けるのに D4.6 は' +
      '「定義した」と言い続ける。producer と消費側が別ファイルにあるため、この不一致は' +
      '原理的に無音になる',
  );
});

// --- Phase 4 敵対的検証統合レポート B-M4: 消費側から producer への逆参照が無い ------------
//
// B1-3.5（コピーするだけの側）は「較正が効いていない」警告が鳴ったときの戻り先を持つが、
// E1.2（消費側）の else は「未定義のためスキップ」と言うだけで、定義しに戻る先が無い。
// 読み手が D4.6 の存在を知らない限り、E1.2 の「未定義」表示を見ても何もできない。

test('AC63: E1.2（消費側）から D4.6（producer）への逆参照がある', () => {
  const md = fs.readFileSync(DEV_SHIP_MD, 'utf8');
  const e1_2 = section(md, '### E1.2');
  assert.ok(e1_2.length > 100, 'E1.2 節の切り出しに失敗した');
  assert.ok(
    e1_2.includes(
      '> **定義したい場合は `/dev-verify` の D4.6（`test:e2e:core` を対話で定義する唯一の producer）へ。**',
    ),
    'E1.2 節に D4.6（producer）への逆参照が無い。「未定義のためスキップ」を見た読み手が' +
      '定義しに戻る先を持たない（統合レポート B-M4。B1-3.5⇔B1-3.6 の逆参照と同型の欠落）',
  );
});

// --- Phase 4 敵対的検証統合レポート B-M8: D4.6 が D5 のループ列挙から漏れている ------------
//
// D4 は「全テストが PASS するまで次に進まない」が、D5 のループ列挙が `D4 / D4.5 / D5` の
// ままだと、E2E が一度でも赤いと D4.6 を通らずに D6 へ抜ける経路がある。

test('AC64: D5 のループ列挙に D4.6 が含まれる', () => {
  const md = fs.readFileSync(DEV_VERIFY_MD, 'utf8');
  const d5 = section(md, '### D5.');
  assert.ok(d5.length > 50, 'D5 節の切り出しに失敗した');
  assert.ok(
    d5.includes('4. 全テスト PASS かつ Critical 0 件になるまで D4 / D4.5 / D4.6 / D5 のループを繰り返す'),
    'D5 のループ列挙が `D4 / D4.5 / D5` のままで D4.6 が含まれていない。' +
      'E2E が一度でも赤いと D4.6 を通らずに D6 へ抜ける経路がある（統合レポート B-M8）',
  );
});

// --- Phase 4 敵対的検証統合レポート U-10: Phase 2 の記述が Phase 3 の成果物を無効化 ----------
//
// size-tier-conf.md は「B1-3.6 は未実装」「作成は自分で行う必要がある」と書いたままだが、
// HEAD には dev-setup/SKILL.md に `#### B1-3.6.` が実在する（Issue #45 Phase 3 で実装済み）。
// plugin 同梱の参照ドキュメントが、新設した producer の迂回を案内している状態。
//
// ⚠ 元の文はソース上2行に折り返されている（`このテンプレート` / `ファイル自体を作る導線は…`）
// ため、素朴な includes だと改行の有無に依存して壊れやすい。空白を全部除去してから
// 部分一致させることで、implementer が改行位置を変えても検知力を保つ（語の存在チェックでは
// なく、否定文・肯定文それぞれの一続きの文そのものを固定している）。
const SIZE_TIER_CONF_MD = path.join(SKILLS_DIR, '_shared', 'reference', 'size-tier-conf.md');
const noWs = (s) => s.replace(/\s+/g, '');

test('AC65: size-tier-conf.md が B1-3.6 の実在を反映している（Phase 2 の記述が Phase 3 成果物を無効化していない）', () => {
  const md = fs.readFileSync(SIZE_TIER_CONF_MD, 'utf8');
  const flat = noWs(md);

  const oldClaim = noWs('このテンプレートファイル自体を作る導線は現状 dev-flow に無い');
  assert.ok(
    !flat.includes(oldClaim),
    'size-tier-conf.md に「このテンプレートファイル自体を作る導線は現状 dev-flow に無い」という' +
      '否定文が残っている。`dev-setup/SKILL.md` には `#### B1-3.6.` が実在する' +
      '（Issue #45 Phase 3 で実装済み）ため、この文はもう事実に反する（統合レポート U-10）',
  );

  const producerRef = noWs('このテンプレートを作る導線は `dev-setup` の B1-3.6（対話で生成する）にある。');
  assert.ok(
    flat.includes(producerRef),
    'size-tier-conf.md から B1-3.6 を作成導線として案内する行が見つからない。' +
      '否定文を消すだけでなく、実在する producer への案内を足すこと' +
      '（片方だけだと「否定は消えたが案内も無い」宙ぶらりんな記述になる）',
  );
});

// --- conf 実例のドリフト検出（Issue #45 セルフレビュー M-4）------------------------
//
// 較正の実例（業務リポジトリの較正由来の exclude 6行＋閾値2行）は size-tier-conf.md（正準の説明側）と
// dev-setup B1-3.6（対話生成の完成形として提示する側）に byte-identical で複製されている。
// core-flow.md の消費側6箇所には複製のドリフト検出があるのに、Issue #45 自身が新設した
// この2ファイル間には無く、片方だけ数値を変えても機械的に検知できない状態だった。
//
// 片方だけ動くと何が壊れるか: B1-3.6 を読んだエージェントが提示する完成形と、
// size-tier-conf.md が「この値ならこう効く」と説明している実測根拠（PR #273 の 79% が
// テストコード・既定 100/500 では L に張り付く）が食い違い、根拠の無い数値が配られる。

// info string を明示して抜く。節の先頭から最初のフェンスを取ると、B1-3.6 では手順1の
// bash（行数分布の調べ方）に当たってしまう。dev-setup 側に「このフェンスの info string は
// conf 固定」という HTML コメントがあるのは、まさにこの抽出を成立させるため。
function confFence(md, heading, info, label) {
  const sec = section(md, heading);
  assert.ok(sec.length > 0, `${label}: 「${heading}」節が見つからない`);
  const m = sec.match(new RegExp('```' + info + '\\n([\\s\\S]*?)```'));
  assert.ok(m, `${label}: 「${heading}」節に \`\`\`${info} のフェンスが無い`);
  return m[1];
}

test('AC69: conf 実例が size-tier-conf.md と dev-setup B1-3.6 で一致している', () => {
  const canonical = confFence(
    fs.readFileSync(SIZE_TIER_CONF_MD, 'utf8'),
    '## 較正の考え方と実例',
    'conf',
    'size-tier-conf.md',
  );
  const inlined = confFence(
    fs.readFileSync(DEV_SETUP_MD, 'utf8'),
    '#### B1-3.6.',
    'conf',
    'dev-setup/SKILL.md',
  );
  assert.strictEqual(
    inlined, canonical,
    'conf 実例が2箇所でドリフトしている。\n' +
      '--- size-tier-conf.md「較正の考え方と実例」---\n' + canonical +
      '--- dev-setup B1-3.6 ---\n' + inlined +
      '片方だけ直すと、B1-3.6 が提示する完成形と size-tier-conf.md の実測根拠が食い違う。' +
      '値を変えるなら両方を揃えること（core-flow.md の消費側6箇所と同じ扱い）',
  );

  // 実例が空・コメントだけに退化していないことも見る。判定器は conf_applied（設定が1行でも
  // 実際に効いたか）で fail-loud するので、効かない実例を配ると警告が鳴り続ける。
  const effective = canonical
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('#'));
  assert.ok(
    effective.length >= 2,
    'conf 実例に実効行（コメント・空行以外）が2行未満しかない。' +
      'コメントだけのテンプレートを配ると conf_applied が立たず、判定器の警告が鳴り続ける' +
      '（Issue #45 が「雛形を置くだけにしない」と決めた理由そのもの）',
  );
});
