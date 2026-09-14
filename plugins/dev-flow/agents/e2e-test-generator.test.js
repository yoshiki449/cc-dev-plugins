#!/usr/bin/env node
'use strict';

// E2E spec の「生成経路」についての記述が、プラグイン内で一貫しているかを検証する（Issue #44 問題3）。
// 実行: node --test plugins/dev-flow/agents/e2e-test-generator.test.js
//
// なぜ必要か:
//   security spec を実際に生成しているのは e2e-test-generator の Step 8 だけで、
//   security-tester は実機検証しか担当しない（本ファイル作成時点で security-tester.md に
//   spec 生成手順は存在しない）。にもかかわらず dev-verify / dev-ship の両方が
//   「生成は D4.5 の security-tester が担当」と書いていた。
//
//   この誤記述が危険なのは、それ自体では何も壊れないこと。壊れるのは
//   **誤記述を信じて Step 8 を消したとき**で、そのとき security spec は
//   「担当者が居るはずだから」という理由で誰にも生成されなくなる。
//   Issue #44 問題2（3本セットの削減）はまさにその作業なので、先にここを固定する。
//
// 落ちたときの直し方:
//   実際の生成経路がどこかを `security-tester.md` と `e2e-test-generator.md` で確認し、
//   **実態の側を正として**記述を直す。記述に合わせて実装を変えるのは順序が逆。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// 節の切り出しは skill-md-gate-tables.test.js と共有する。複製すると片方だけ直したときに
// 節境界の欠陥（コードフェンス内の `#` を見出しと誤認する）がもう片方で復活する。
const { section } = require('../skills/_shared/scripts/md-section.js');

const AGENTS_DIR = __dirname;
const PLUGIN_DIR = path.join(AGENTS_DIR, '..');
const SKILLS_DIR = path.join(PLUGIN_DIR, 'skills');

const E2E_GENERATOR_MD = path.join(AGENTS_DIR, 'e2e-test-generator.md');
const SECURITY_TESTER_MD = path.join(AGENTS_DIR, 'security-tester.md');
const DEV_VERIFY_MD = path.join(SKILLS_DIR, 'dev-verify', 'SKILL.md');
const DEV_SHIP_MD = path.join(SKILLS_DIR, 'dev-ship', 'SKILL.md');
const BUILD_WORKFLOW = path.join(PLUGIN_DIR, 'workflows', 'build.workflow.js');
// Issue #45 Phase 1: 「コア導線」の正準定義ファイル。消費側6箇所はここの該当例を複製する。
const CORE_FLOW_MD = path.join(SKILLS_DIR, '_shared', 'reference', 'core-flow.md');

const read = (p) => fs.readFileSync(p, 'utf8');

// --- 生成経路そのもの（アンカー）------------------------------------------------

test('security spec の生成手順が e2e-test-generator に存在する', () => {
  const md = read(E2E_GENERATOR_MD);
  assert.ok(
    md.includes('### S. セキュリティテスト'),
    'e2e-test-generator.md から「S. セキュリティテスト」節が消えている。' +
      'これが security spec の唯一の生成元で、消えると誰も生成しなくなる',
  );
  assert.ok(
    /security\/<機能名>-security\.spec\.ts/.test(md),
    'security spec の出力先パスが e2e-test-generator.md から消えている',
  );
});

test('security-tester は spec を生成しない（実機検証の担当である）', () => {
  const md = read(SECURITY_TESTER_MD);
  // 実態が変わって security-tester が生成側に回るなら、それは設計変更なので
  // このテストを消すのではなく、上の「唯一の生成元」の主張ごと見直すこと。
  // `.` は改行に当たらないため、当初の正規表現は「同一行」かつ「パスが動詞より前」の
  // 語順でしか検出できなかった（レンズ A M-3 が別表現の生成手順を追加して実測）。
  // 行境界と語順の両方から外す。
  assert.ok(
    !/security[^\n]*\.spec\.ts[\s\S]{0,200}?を(生成|作成)/.test(md) &&
      !/(生成|作成)[\s\S]{0,200}?security[^\n]*\.spec\.ts/.test(md),
    'security-tester.md に spec 生成手順が現れた。生成元が2箇所になると、' +
      'どちらが正かを消費側が判断できなくなる（本 Issue の記述矛盾の再発）',
  );
});

// --- 誤記述の復活防止（dev-flow 配下の全 md / js を横断スキャン）------------------
//
// 特定ファイルだけを見ると、同じ誤解が別ファイルにコピーされたときに素通りする。
// 実際 Issue #44 は dev-verify:70 だけを挙げていたが、実測すると dev-ship:126 にも
// 同じ誤解が伝播していた（本文に無い3箇所目）。だから横断で禁止する。

const FORBIDDEN = [
  {
    pattern: /e2e-test-generator\s*は\s*セキュリティ観点を扱わない/,
    why: 'e2e-test-generator の Step 8 が実際に security spec を生成している。この記述を信じて Step 8 を消すと生成経路が消滅する',
  },
  {
    pattern: /D4\.5\s*で\s*(生成|作成)/,
    why: 'D4.5（security-tester）は実機検証のみで spec を生成しない。生成元は D3 の e2e-test-generator',
  },
  {
    pattern: /security-tester\s*が\s*一括で担当/,
    why: '「生成も実機検証も security-tester」という誤解の元。生成＝e2e-test-generator / 実機検証＝security-tester と分けて書く',
  },
];

function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'fixtures' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    // symlink は isDirectory() が false になるため、そのままだと (a) ディレクトリ symlink の
    // 中身が無音でスキャン対象外になり (b) 壊れた symlink や .md 名のディレクトリ symlink で
    // readFileSync が throw してテストごとクラッシュする。実体を stat して判定する。
    const stat = entry.isSymbolicLink() ? fs.statSync(full, { throwIfNoEntry: false }) : entry;
    if (!stat) continue; // 壊れた symlink
    if (stat.isDirectory()) walk(full, acc);
    else if (/\.(md|js)$/.test(entry.name) && !entry.name.endsWith('.test.js')) acc.push(full);
  }
  return acc;
}

// md の強調記号を落としてから照合する。原文は「**D4.5 の security-tester** が一括で担当」の
// ように語の途中に `**` が挟まるため、素の正規表現では書いたつもりの禁止が無音で効かなくなる。
const normalize = (text) => text.replace(/[*`]/g, '');

test('security 生成経路についての誤記述が dev-flow 配下のどこにも無い', () => {
  const files = walk(PLUGIN_DIR);
  // 実測 94 件（agents 31 / skills 54 / templates 5 / workflows 2 / reference 2）。
  // 20 だと skills/ が丸ごと降下不能になっても通ってしまうので実数に寄せる。
  assert.ok(files.length > 50, `走査対象が ${files.length} 件しかない。walk() が壊れている疑い`);

  const hits = [];
  for (const file of files) {
    const text = normalize(read(file));
    for (const { pattern, why } of FORBIDDEN) {
      if (pattern.test(text)) {
        hits.push(`${path.relative(PLUGIN_DIR, file)}: ${pattern} — ${why}`);
      }
    }
  }
  assert.deepStrictEqual(hits, [], `security 生成経路の誤記述が復活している:\n${hits.join('\n')}`);
});

// --- 消費側が生成元を正しく書いているか（正の主張）-------------------------------

// ⚠ 文書全域の includes で検査してはいけない。当初この検査は
//    `md.includes('e2e-test-generator') && md.includes('security-tester')` と
//    `/生成/ && /実機検証/` を**ファイル全体**に当てていたが、`e2e-test-generator` は D3 本文に、
//    `生成` は無数に、`実機検証` は D4.5 の説明に別途出現するため、
//    **問題の注記を丸ごと誤記述に差し替えても全部 pass した**（レンズ A M-1 が実測）。
//    「役割分担が書かれている」と主張しているつもりで「4語が同じファイルのどこかにある」
//    ことしか主張していなかった。対象を注記ブロックそのものに絞る。
test('dev-verify D3 の注記が生成と実機検証の担当を名指しで分けている', () => {
  const notes = notesOf(section(read(DEV_VERIFY_MD), '### D3.'));
  assert.ok(notes.length > 0, 'dev-verify D3 に役割分担の注記（blockquote）が無い');

  assert.ok(
    /生成[\s\S]{0,120}?e2e-test-generator/.test(notes),
    'D3 の注記が「生成の担当 = e2e-test-generator」を名指ししていない。' +
      '言い換えによる誤記述の復活は禁止パターンでは捕まえきれないため、' +
      '正しい対応関係が書かれていることを正の主張で固定する',
  );
  assert.ok(
    /security-tester[\s\S]{0,120}?実機検証|実機検証[\s\S]{0,120}?security-tester/.test(notes),
    'D3 の注記が「実機検証の担当 = security-tester」を名指ししていない',
  );
});

test('auto-build の生成プロンプトが security spec を指示している', () => {
  const src = read(BUILD_WORKFLOW);
  const m = src.match(/`あなたは e2e-test-generator エージェントです。[\s\S]*?`/);
  assert.ok(m, 'build.workflow.js から e2e-test-generator の生成プロンプトが見つからない');
  assert.ok(
    /security|セキュリティ/i.test(m[0]),
    'auto-build の e2e 生成プロンプトが security spec に言及していない。' +
      'このプロンプトは user-stories / functional しか指示しないため、' +
      'auto-build 経路では Step 8 が走る保証がない（対話フローとの非対称）',
  );
});

// --- Phase 2 が実際に触る行を守る ------------------------------------------------
//
// アンカーを「### S. セキュリティテスト」節（テンプレート定義）と出力先パスだけに置くと、
// **エージェントが「生成する」と読む唯一の指示であるワークフロー手順の行**が検査から漏れる。
// 問題2（3本セットの削減）が編集するのはまさにその手順リストなので、守りたい性質と
// 照合する文字列が別の場所に住むことになる（実測: Step 8 の行だけを消しても 5/5 pass だった）。

/** 節の中の blockquote（`>` 行）だけを取り出す。役割分担の注記はここに書かれている。 */
const notesOf = (sec) => sec.split('\n').filter((l) => l.trimStart().startsWith('>')).join('\n');

test('ワークフロー手順に security spec の生成ステップが残っている', () => {
  const workflow = section(read(E2E_GENERATOR_MD), '## ワークフロー');
  // 手順番号には依存しない。Phase 2 で 6/7 が条件化されると採番が動きうるため。
  assert.ok(
    /セキュリティテストを生成/.test(workflow),
    'ワークフロー手順から security spec の生成ステップが消えている。' +
      '「### S. セキュリティテスト」節はテンプレートの定義であって手順ではないので、' +
      'あちらが残っていてもエージェントは生成しない',
  );
  assert.ok(
    /security\/<機能名>-security\.spec\.ts/.test(workflow),
    'ワークフロー手順の中に security spec の出力先が無い（節の外のパス記述では手順にならない）',
  );
});

test('security テンプレート節の中身（S1〜S5）が実在する', () => {
  const md = read(E2E_GENERATOR_MD);
  // 見出しだけ残して中身を空にすると、アンカーは生きたまま実質が消える。
  for (const n of [1, 2, 3, 4, 5]) {
    assert.ok(
      new RegExp(`#### S${n}\\.`).test(md),
      `security テンプレートの S${n} が消えている（節見出しだけが残ると検査が形骸化する）`,
    );
  }
});

test('dev-ship が security spec の生成元を D3 と書いている', () => {
  const md = read(DEV_SHIP_MD);
  // 禁止パターン（D4.5 で生成）を消しただけでは「生成元が書かれていない」状態も通ってしまう。
  // 負の主張だけでなく正の主張を置く。
  assert.ok(
    /生成元は[^。]*D3/.test(md),
    'dev-ship/SKILL.md に security spec の生成元（D3 の e2e-test-generator）が明記されていない',
  );
});

// --- 生成プロンプトの「極性」を固定する ------------------------------------------
//
// 当初のテストは /security|セキュリティ/ の**語の存在**しか見ておらず、
// 「セキュリティテストは security-tester が別途担当するためここでは生成しないこと」に
// 反転しても 5/5 pass した（レンズ A が実測）。削除は語が消えるので落ちるが、
// 現実に起きやすいのは削除ではなく書き換えなので、肯定表現そのものを契約にする。

test('auto-build の生成プロンプトが security spec を「必ず生成」と指示している', () => {
  const src = read(BUILD_WORKFLOW);
  const m = src.match(/`あなたは e2e-test-generator エージェントです。[\s\S]*?`/);
  assert.ok(m, 'build.workflow.js から e2e-test-generator の生成プロンプトが見つからない');
  assert.ok(
    /必ず生成/.test(m[0]),
    'auto-build の e2e 生成プロンプトから「必ず生成」の指示が消えている。' +
      '語の存在だけでは極性（生成しろ／するな）を固定できないため、この肯定表現を契約とする。' +
      '文言を変えるならこのテストも同時に直すこと',
  );
  assert.ok(
    /security|セキュリティ/i.test(m[0]),
    'auto-build の e2e 生成プロンプトが security spec に言及していない',
  );
});

// --- 「全空」が正常系と区別できる状態を保つ --------------------------------------
//
// 本 diff は user_stories / functional の空配列を「正常系」に格上げした。それ自体は妥当だが、
// spec_paths まで空（＝security spec すら未生成）のときに、それを検出する機械ゲートが
// ワークフロー内に1つも無かった（レンズ B が実測: openIssues が空 → FixLoop に入らない →
// supervisor も stop-judge も起動しない → finalStatus=partial-green のまま PR が作られる）。

test('E2E_SUITE_SCHEMA が spec_paths の空を許さない', () => {
  const src = read(BUILD_WORKFLOW);
  const schema = src.match(/const E2E_SUITE_SCHEMA = \{[\s\S]*?\n\}/);
  assert.ok(schema, 'E2E_SUITE_SCHEMA が見つからない');
  assert.ok(
    /spec_paths:\s*\{[^}]*minItems:\s*1/.test(schema[0]),
    'E2E_SUITE_SCHEMA.spec_paths に minItems: 1 が無い。security spec は「必ず生成」なので ' +
      '下限1は仕様と矛盾しない。これが無いと全空返却（E2E ゼロ）が schema 上は正当になり、' +
      '軽量ケースと区別できなくなる',
  );
});

// ⚠ この検査は判定式の**字面**を固定する。実挙動は検査していない。
//    workflow スクリプトは Workflow ランタイムのグローバル（agent / log / phase）に依存し、
//    Node.js API を持たないため require できず、ロジックを切り出して実行することができない。
//
//    字面を固定する理由は実測に基づく: 当初この検査は /e2eResult[^\n]*total/ で
//    「語の存在」だけを見ており、`const e2eEmpty = false && e2eResult && ...` という
//    無効化変異が**素通りした**（レンズ A C-2 が別箇所で指摘したのと同じ「極性を見ていない」欠陥）。
//
//    したがってこの検査が捕まえるのは「式が書き換えられたこと」であって
//    「ゲートが機能すること」ではない。式を意図的に変えるならこのテストも同時に直すこと。
//
//    完全一致なので式への変異（`false &&` の挿入・`=== -1` へのすり替え）はすべて落ちる。
//    捕まえられないのは**式を保ったまま外側で無効化する**変異: openIssues をこの後で
//    再代入する、e2eResult 自体が undefined になる経路を足す、など。実挙動を見ていない
//    以上ここが上限で、それは workflow を実走させる eval（loop-eval）の担当範囲。
const E2E_EMPTY_GUARD =
  'const e2eEmpty = e2eResult && Number.isFinite(e2eResult.total) && e2eResult.total === 0';

test('E2E がゼロ本だった場合に openIssues へ積む経路がある', () => {
  const src = read(BUILD_WORKFLOW);
  assert.ok(
    src.includes(E2E_EMPTY_GUARD),
    `build.workflow.js の E2E ゼロ判定が字面どおりでない。期待:\n  ${E2E_EMPTY_GUARD}\n` +
      'total===0（テストが1本も無い）は failure_details が空のまま success に見えるため、' +
      'ここを見ないと「E2E ゼロで partial-green のまま PR」が無音で成立する',
  );
  // 判定した結果を実際に openIssues へ積んでいること。判定だけして使わない状態を防ぐ。
  assert.ok(
    /\.\.\.\(e2eEmpty \? \[\{/.test(src),
    'e2eEmpty を判定しているが openIssues に積んでいない。判定されているが誰も見ていないゲートになる',
  );
});

// --- Phase 2: user-stories / functional の条件付き生成（Issue #44 問題2）------------
//
// 業務リポジトリの実測: E2E spec 55本・約1MB に対し **CI で回っている E2E は 0本**。
// 1 Issue につき user-stories / functional / security の3本が無条件に増え続け、
// CI に載っていないため腐り、「E2E spec 120件の失敗を解消」(+3,973/-1,730) のような
// まとめ直し事故になる。生成規約そのものを条件付きに変える。
//
// **security（Step 8）は条件化の対象外**。上の「ワークフロー手順に security spec の
// 生成ステップが残っている」テストが無条件であることを担保している。

const CONDITIONAL_STEPS = [
  { label: 'ユーザーストーリーテスト', anchor: '6. ' },
  { label: '機能テスト', anchor: '7. ' },
];

test('ワークフローの user-stories / functional が条件付き生成になっている', () => {
  const workflow = section(read(E2E_GENERATOR_MD), '## ワークフロー');

  // ⚠ 節全体に対する検査では足りない。実測では手順6の指示を「常に生成する」に反転しても、
  //    下の解説文（「なぜ既定を『生成しない』にしたか」）に残った同じ語がマッチして pass した。
  //    エージェントが実際に読んで従うのは手順行なので、手順行そのものを1行ずつ見る。
  const lines = workflow.split('\n');
  for (const { label, anchor } of CONDITIONAL_STEPS) {
    const line = lines.find((l) => l.trimStart().startsWith(anchor));
    assert.ok(line, `ワークフローに手順「${anchor}」（${label}）が見つからない`);
    assert.ok(
      /既定では生成しない|既定で生成しない/.test(line),
      `ワークフロー手順「${anchor}」（${label}）が無条件の生成指示に戻っている:\n  ${line}\n` +
        'build.workflow.js のプロンプトは既に条件付きなので、ここが無条件だと' +
        'エージェントが読む2つの指示が正面から矛盾し、空配列を返すか従来どおり生成するかが' +
        '実行ごとに揺れる（＝空が正常系と言いながら、空になる条件が定義されていない状態）',
    );
  }

  // ⚠ 節全体に当てないこと。実測では条件(2)の**定義行**を削除しても、下の解説文
  //    「functional は pytest / vitest でカバーできる範囲がほとんど」がマッチして 13/13 pass した。
  //    2条件を定義しているのは注記ブロック（`>` 行）の中の番号付き行なので、そこに限定する。
  const notes = workflow.split('\n').filter((l) => l.trimStart().startsWith('>')).join('\n');
  assert.ok(notes.length > 0, 'ワークフローに「生成してよい2条件」の注記ブロックが無い');

  assert.ok(
    /1\.\s*\*\*コア導線/.test(notes),
    '生成条件(1)「コア導線そのものを変更する場合」の定義行が注記ブロックに無い' +
      '（解説文の中に語が残っていても条件の定義にはならない）',
  );
  assert.ok(
    /2\.\s*\*\*pytest \/ vitest/.test(notes),
    '生成条件(2)「pytest / vitest では原理的に検証できない場合」の定義行が注記ブロックに無い',
  );
  assert.ok(
    /理由を[^\n]*コメントに明記/.test(notes),
    '生成した場合に理由を spec 冒頭コメントへ明記する指示が無い。' +
      'これが無いと、後から「なぜこの spec が要るのか」を判断できない spec が積み上がる',
  );
});

test('dev-verify D4 が「生成しなかったカテゴリ」の実行方法を定めている', () => {
  const d4 = section(read(DEV_VERIFY_MD), '### D4. E2E テスト実行');

  // Playwright は spec 0本で "No tests found" → exit 1（レンズ B が 1.49.1 で実測）。
  // D4 は「全テストが PASS するまで次に進まない」と書いているので、生成しなかった
  // カテゴリのスクリプトが exit 1 を返すと、読んだ LLM は「E2E が落ちている」と解釈して
  // D5（バグ修正）に入る。直す対象のテストは存在しない。
  // ⚠ 「生成しなかった」の語が節のどこかにあることを見るだけでは足りない。実測では
  //    指示の本文（「実行しない」）を「全カテゴリを実行する」に反転しても、注記の別の文に
  //    残った同じ語がマッチして pass した。指示そのものを1つの正規表現で固定する。
  assert.ok(
    /生成しなかったカテゴリ[^\n]*実行しない/.test(d4),
    'dev-verify D4 に「D3 で生成しなかったカテゴリのスクリプトは実行しない」の指示が無い。' +
      'D3 には「問題2 で条件付きにする」と予告を書いたのに、その帰結を受ける D4 に対応が無い状態。' +
      'Playwright は spec 0本で exit 1 を返すため、生成していないカテゴリを実行すると' +
      '「E2E が落ちている」ように見え、存在しないテストを D5 で直そうとすることになる',
  );
  assert.ok(
    /pass-with-no-tests/.test(d4),
    'D4 に、一括実行したい場合の逃げ道（カテゴリ別スクリプトへの --pass-with-no-tests）が無い',
  );
  // 一括で握りつぶすのは禁止。security spec ゼロという本命ケースまで隠蔽して exit 0 になる。
  // ⚠ npm へフラグを渡す正式な構文は `npm run <script> -- <flag>` なので、
  //    `test:e2e --pass-with-no-tests` の隣接だけを見ると **正しい書き方が素通りする**
  //    （レンズ A が実測。Playwright 1.58 でフラグの実在も確認済み）。
  //    `test:e2e` の直後から行末までの間にフラグが現れたら禁止とする。
  //    カテゴリ別（test:e2e:user-stories 等）は許可なので、コロンが続く場合は対象外。
  assert.ok(
    !/npm run test:e2e(?!:)[^\n]*--pass-with-no-tests/.test(d4),
    'D4 が `npm run test:e2e` 本体に --pass-with-no-tests を付けている。' +
      'これは security spec が0本のケース（＝生成器が何も作らなかった）まで exit 0 に変えてしまう。' +
      'カテゴリ別スクリプトに限定すること',
  );
});

// --- 条件付き生成が「消費側すべて」に着地しているか（レンズ A C-3 / C-4）--------------
//
// 実測で判明した穴: Phase 2 の消費側5箇所のうち **4箇所が無検査**で、
// build.workflow.js のプロンプトを「3本セットを必ず生成」に反転しても 13/13 pass、
// dev-verify D3-3 を「Issue ごとに必ず生成する」に反転しても 19/19 pass、
// designer / DESIGN-template / auto-build を `git checkout main --` で全撤回しても 100/100 pass した。
// 個別に正規表現を足すのではなく、**消費側の一覧そのものをテストに持たせて横断で検査する**。
//
// この表は「どこに書いたか」の記録でもある。消費側を増やしたらここに足す。
//
// `lines` は極性（生成するのかしないのか）を決めている行、`conditionLines` は
// **生成してよい2条件を定めている行**。両方を字面で持つ理由は下の
// 「生成してよい2条件が…」テストのコメントにある。
//
// `exampleLines`（Issue #45 Phase 1）は**条件(1)のインライン例を含む実装後の行**。
// 「コア導線」自体の定義や具体例が dev-flow のどこにも無く、条件(2)には
// 具体例（複数画面をまたぐ状態遷移・ブラウザ固有の挙動）が付いているのに
// 条件(1)は非対称に定義なしのまま6箇所へコピーされていた。正準定義は
// core-flow.md に1箇所（下のテスト参照）、消費側6箇所にはインライン例を複製する
// 構造なので、`conditionLines` とは別に**行全体**を字面固定し、例だけを後から
// 削る変異（極性文は残るので既存 lines / conditionLines テストは pass し続ける）を検知する。
// `section`（Issue #45 敵対的検証 A-1）: exampleLines が実際に存在すべき節の見出し。
// text.includes() だけの検査は位置を見ないため、例を条件(1)の場から剥がして
// ファイル末尾などへ移設しても検知できない（M11: 20/20 green で実測）。
// `null` は「節限定の対象外」を明示する印で、build.workflow.js だけがこれに当たる。
// 理由: build.workflow.js は JS のテンプレートリテラル（1つの文字列）であって
// md の見出し構造を持たないため、section() の前提（`#` 見出しの階層）が成立しない。
// この非対称を書かずに1箇所だけ対象外にすると、後から「消し忘れ」と誤解されて
// 存在しない見出しを追加されるか、逆に他の5箇所まで節限定を外されるおそれがある。
const CONDITIONAL_CONSUMERS = [
  {
    file: BUILD_WORKFLOW,
    label: 'build.workflow.js（auto-build の生成プロンプト）',
    section: null,
    // プロンプトは1つの文字列リテラル。極性を決めている2文を字面で固定する。
    lines: [
      'ユーザーストーリーテスト・機能テストは既定では生成しない。次のいずれかに当たるときだけ生成し、',
      '該当しなければ user_stories / functional は空配列で返してよい（それが正常系）。',
    ],
    conditionLines: [
      '(1) コア導線そのものを変更する場合',
      '(2) pytest / vitest では原理的に検証できない場合（複数画面をまたぐ状態遷移・ブラウザ固有の挙動）',
    ],
    exampleLines: [
      '理由を spec 冒頭のコメントに明記すること: (1) コア導線そのものを変更する場合（ログイン・決済・申請の承認/却下・権限やテナント境界をまたぐ操作）',
    ],
  },
  {
    file: DEV_VERIFY_MD,
    label: 'dev-verify D3-3（対話フローの中核手順）',
    section: '### D3. E2E テスト作成（e2e-test-generator）',
    lines: ['3. **ユーザーストーリーテスト・機能テストは既定では生成しない。**'],
    conditionLines: [
      '1. コア導線そのものを変更する場合',
      '2. pytest / vitest では原理的に検証できない場合（複数画面をまたぐ状態遷移・ブラウザ固有の挙動）',
    ],
    exampleLines: [
      '1. コア導線そのものを変更する場合（ログイン・決済・申請の承認/却下・権限やテナント境界をまたぐ操作）',
    ],
  },
  {
    file: path.join(SKILLS_DIR, 'auto-build', 'SKILL.md'),
    label: 'auto-build の Integrate 説明',
    section: '## 概要',
    lines: ['user-stories / functional は条件付き'],
    // 1行に極性と条件が同居しているので条件部分だけを切り出して固定する。
    conditionLines: ['コア導線の変更 or pytest/vitest で検証不能なときだけ'],
    exampleLines: [
      '- **Integrate**: e2e-test-generator で E2E spec 生成、試走（security spec は常に生成。user-stories / functional は条件付き＝コア導線の変更 or pytest/vitest で検証不能なときだけ。コア導線＝ログイン・決済・申請の承認/却下・権限やテナント境界をまたぐ操作）',
    ],
  },
  {
    file: path.join(AGENTS_DIR, 'designer.md'),
    label: 'designer（DESIGN.md 生成エージェント）',
    section: '### E2E',
    lines: ['user-stories・functional は条件付き生成'],
    conditionLines: ['条件: コア導線そのものの変更、または pytest / vitest では原理的に検証できないもの'],
    // 既存2行の直後に足す新規行なので、他の exampleLines と違い既存行への追記ではない。
    exampleLines: ['- コア導線の例: ログイン・決済・申請の承認/却下・権限やテナント境界をまたぐ操作'],
  },
  {
    file: path.join(PLUGIN_DIR, 'templates', 'DESIGN-template.md'),
    label: 'DESIGN-template（設計書の雛形）',
    section: '### E2E',
    lines: ['user-stories / functional は既定では生成しない'],
    conditionLines: ['(1) コア導線そのものを変更する (2) pytest / vitest では原理的に検証できない'],
    exampleLines: [
      '- **コア導線の例**: ログイン・決済・申請の承認/却下・権限やテナント境界をまたぐ操作',
    ],
  },
  {
    file: E2E_GENERATOR_MD,
    label: 'e2e-test-generator（ワークフロー手順 6・7 の注記ブロック）',
    section: '## ワークフロー',
    // 条件(1)は別テストで /1\.\s*\*\*コア導線/ という接頭辞だけの正規表現で見られており、
    // 「例を追記して後から消す」変異を検知できない。手順 6・7 の極性行を字面固定する。
    lines: [
      '6. ユーザーストーリーテスト → `e2e/tests/user-stories/<機能名>.spec.ts`。**既定では生成しない。**',
      '7. 機能テスト → `e2e/tests/functional/<機能名>-functional.spec.ts`。**既定では生成しない。**',
    ],
    conditionLines: [
      '1. **コア導線そのものを変更する場合**',
      '2. **pytest / vitest では原理的に検証できない場合**（複数画面をまたぐ状態遷移・ブラウザ固有の挙動）',
    ],
    exampleLines: [
      '1. **コア導線そのものを変更する場合**（ログイン・決済・申請の承認/却下・権限やテナント境界をまたぐ操作）',
    ],
  },
];

test('条件付き生成が消費側すべてに着地している', () => {
  const missing = [];
  for (const { file, label, lines } of CONDITIONAL_CONSUMERS) {
    const text = read(file);
    for (const line of lines) {
      if (!text.includes(line)) missing.push(`${label}: 「${line}」が無い`);
    }
  }
  assert.deepStrictEqual(
    missing, [],
    '条件付き生成の記述が消費側から欠けている（無条件生成に巻き戻っている疑い）:\n' +
      missing.join('\n') +
      '\n\n消費側を1箇所でも取りこぼすと、そこを読んだエージェントだけが3本セットを生成し続ける。' +
      'PR #42 で「マーカー契約を変えたのに消費側4箇所のうち2箇所を取りこぼした」のと同型',
  );
});

test('生成してよい2条件が消費側すべてに書かれている', () => {
  // 条件の片方だけが伝わると「なんとなく生成しない」か「常に生成する」に倒れる。
  //
  // ⚠ 語の存在（`/コア導線/.test(全文)` `/pytest|vitest/.test(全文)`）で見てはならない。
  //    実測: DESIGN-template.md には `- **フレームワーク**: <例: Vitest / Jest / pytest>` という
  //    ユニットテストのフレームワーク例示行が別にあるため、**生成条件行から `pytest / vitest` を
  //    削っても3ファイル109件が全 pass する**。しかも落ちる方向が悪く、消費側から条件だけが消えて
  //    極性文（「既定では生成しない」）が残ると、読んだエージェントは「常に生成しない」に倒れる
  //    ＝ Issue #44 の問題2 が最も警戒していた失敗そのものになる。
  //
  //    条件を定めている行そのものを `conditionLines` で字面固定する。上の
  //    「条件付き生成が消費側すべてに着地している」が極性を、こちらが条件を守る。
  const missing = [];
  for (const { file, label, conditionLines } of CONDITIONAL_CONSUMERS) {
    const text = read(file);
    for (const line of conditionLines) {
      if (!text.includes(line)) missing.push(`${label}: 条件行「${line}」が無い`);
    }
  }
  assert.deepStrictEqual(
    missing, [],
    '生成条件を定めている行が消費側から欠けている:\n' +
      missing.join('\n') +
      '\n\n極性文だけが残って条件が消えると「常に生成しない」に倒れる',
  );
});

// --- Issue #45 Phase 1: 「コア導線」の定義とインライン例 -----------------------------
//
// 条件(1)「コア導線そのものを変更する場合」には、条件(2)と違って定義も具体例も
// dev-flow のどこにも無い。エージェント定義やプロンプト文字列は実行時に他ファイルを
// 読めないため（Issue #44 で確立済み）、正準定義を1箇所（core-flow.md）に置きつつ、
// 消費側6箇所にはインライン例を複製する。「正準1箇所＋複製＋ドリフト検出」という構造。

test('コア導線のインライン例が消費側6箇所すべてに揃っている', () => {
  // ⚠ 語の存在（/コア導線/.test(全文)）で見てはならない。#44 で「本物の条件行から
  //    条件を削っても全 pass する」事故が起きたのと同型の穴になる。
  //    ここは `exampleLines`（実装後に条件(1)の行がどうなっているべきかを字面固定した行）
  //    そのものが text.includes() で見つかるかどうかだけを見る。
  const missing = [];
  for (const { file, label, exampleLines } of CONDITIONAL_CONSUMERS) {
    const text = read(file);
    for (const line of exampleLines) {
      if (!text.includes(line)) missing.push(`${label}: インライン例の行「${line}」が無い`);
    }
  }
  assert.deepStrictEqual(
    missing, [],
    'コア導線のインライン例が消費側から欠けている:\n' +
      missing.join('\n') +
      '\n\n条件(2)には具体例が付いているのに条件(1)だけ定義なしという非対称が残ると、' +
      '読んだ人・エージェントごとに「コア導線」の解釈が割れ、E2E を生成すべきかの判断が' +
      '実行のたびに揺れる（Issue #45 の起票理由そのもの）',
  );
});

// md の HTML コメントを（長さを保ったまま）空白へ落とす。コメントアウトされた記述は
// 読み手に提示されていないので、「書いてある」と数えてはならない。
function stripHtmlComments(md) {
  return md.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
}

const CORE_FLOW_EXAMPLE = 'ログイン・決済・申請の承認/却下・権限やテナント境界をまたぐ操作';

// 非該当例3つ。ここも語の存在ではなく行の字面で固定する（挙動を決めている行は
// 「該当しない」と明言している行そのものであって、単に単語が出てくるだけの
// 解説文ではない）。
const CORE_FLOW_NON_EXAMPLES = [
  '単純な CRUD のバリデーション追加',
  '表示調整・文言変更',
  '単一画面内で完結する状態変化',
];

// 判断に迷ったときにどちらへ倒すかという極性そのものを固定する行。反転
// （非該当側に倒す＝生成しない方向）が紛れ込んでも既存の語検索では検知できないため、
// 「該当する」「生成する」側に倒す、という具体語を含む行として固定する。
const CORE_FLOW_FALLBACK_LINE = '判断に迷ったときは、該当する（生成する）側に倒す';

test('コア導線の正準定義ファイルが新設されている（core-flow.md）', () => {
  assert.ok(
    fs.existsSync(CORE_FLOW_MD),
    'plugins/dev-flow/skills/_shared/reference/core-flow.md が存在しない。' +
      '「コア導線」の定義・該当例・非該当例・判断の倒し方を1箇所に集約する正準ファイルが無いと、' +
      '消費側6箇所のインライン例がそれぞれ独自解釈でドリフトしても誰も気づけない',
  );
});

test('core-flow.md が正準の該当例（消費側6箇所と同じ字面）を含んでいる', () => {
  const md = read(CORE_FLOW_MD);
  assert.ok(
    md.includes(CORE_FLOW_EXAMPLE),
    'core-flow.md に正準の該当例「' + CORE_FLOW_EXAMPLE + '」が含まれていない。' +
      'この文字列は消費側6箇所のインライン例にもそのまま複製される前提のため、' +
      '正準ファイル側の字面が違うと定義と複製がドリフトした状態で発行されることになる',
  );

  // ⚠ ファイル全体への includes だけでは足りない（Issue #45 敵対的検証 A-3）。
  //    実測: 該当例をコメントアウトして「## 該当例」節から HTML コメントの中だけへ
  //    移設しても、上のファイル全体検査は 20/20 green のままだった（M12）。
  //    「正準として提示されている」ことを見るには、実際に「## 該当例」節の中に
  //    あることまで確認する必要がある。
  // HTML コメントを落としてから照合する。節に限定するだけでは足りず、実測では
  // **節の内側**に `<!-- ... -->` で退避する変異が 24/24 green のまま素通りした。
  // コメントアウトされた記述は読み手に提示されていないので、あるとは数えない。
  // `section()`（md-section.js）側でマスクしないのは、あちらが節の**境界検出**の
  // ヘルパーで、返す本文は原文であるという契約だから。ここはその本文の解釈側にあたる。
  const sec = stripHtmlComments(section(md, '## 該当例'));
  assert.ok(
    sec.includes(CORE_FLOW_EXAMPLE),
    'core-flow.md の「## 該当例」節の中に正準の該当例が見つからない。' +
      'ファイル全体には含まれていても、節の外へ退避されているか、HTML コメントで' +
      'コメントアウトされていて実質的に「提示されていない」状態になっている疑いがある',
  );
});

test('core-flow.md が非該当例を明示している', () => {
  const md = read(CORE_FLOW_MD);
  // 「## 該当例」側と同じ手当てを入れる。ファイル全体への includes だけだと、節の外へ
  // 退避しても HTML コメントへ落としても素通りする（実測: 「単純な CRUD のバリデーション
  // 追加」を節から削除しファイル冒頭のコメントへ移すと 24/24 green のままだった）。
  // 非該当例は「非該当だと提示されている」ことに意味があるので、節の中に生きた行として
  // 存在するかまで見る。
  const sec = stripHtmlComments(section(md, '## 非該当例'));
  const missing = CORE_FLOW_NON_EXAMPLES.filter((line) => !sec.includes(line));
  assert.deepStrictEqual(
    missing, [],
    'core-flow.md の「## 非該当例」節に非該当例が欠けている:\n' + missing.join('\n') + '\n\n' +
      'ファイル全体には含まれていても、節の外へ退避されているか HTML コメントで' +
      'コメントアウトされていて実質的に「提示されていない」状態になっている疑いがある。\n' +
      '該当例だけでは「コア導線に見えるが実は当たらない」ケース（単純な CRUD 追加・表示調整・' +
      '単一画面内の状態変化）で判断が割れる。条件(2)には具体例が付いているのに条件(1)には' +
      '無いという非対称（Issue #45 の起票理由）を、該当例だけ書いて再発させないための固定',
  );
});

test('core-flow.md が判断に迷ったときの倒し方（該当側）を明示している', () => {
  const md = read(CORE_FLOW_MD);
  // 極性を固定するテストこそ節限定とコメント除去が要る。実測: 本文の判断行を
  // 「該当しない（生成しない）側に倒す」へ反転したうえで、元の正しい行を HTML コメントとして
  // 節の先頭に残すと、ファイル全体への includes は 24/24 green のまま通った。
  // 反転が素通りすると条件付き生成が「常に該当しない」に倒れる（Issue #45 が最も警戒する失敗）。
  const sec = stripHtmlComments(section(md, '## 判断に迷ったときの倒し方'));
  assert.ok(
    sec.includes(CORE_FLOW_FALLBACK_LINE),
    'core-flow.md の「## 判断に迷ったときの倒し方」節に' +
      '「迷ったら該当する（生成する）側に倒す」という倒し方の行が無い。' +
      '節の外・HTML コメントの中にある字面は「提示されている」と数えない。' +
      'この極性が書かれていないと、コア導線かどうか自信が持てないケースで' +
      '生成しない方向に倒れ続け、条件付き生成の既定（Issue #44 問題2）と組み合わさって' +
      'コア導線の変更が無テストのまま通過するリスクが常に「生成しない」側に偏る',
  );
});

// --- Issue #45 敵対的検証で見つかった検知穴（Major 4件）--------------------------
//
// レンズ A / B が実測した5変異のうち、指示された12変異では検知できなかったもの。
// .agent/adversarial-review-45-phase1-統合.md を参照。

// --- U-1: 正準定数と exampleLines の紐付けが無い ---------------------------------
//
// 実測: テストファイル内に正準文字列（CORE_FLOW_EXAMPLE と exampleLines 6個）が
// 互いに独立した7個のリテラルとして存在する。そのため正準を書き換えたとき、
// green に戻す最小操作が「CORE_FLOW_EXAMPLE 定数だけ直す」になり、消費側6箇所は
// 旧字面のまま全 pass してしまう。exampleLines の各行が CORE_FLOW_EXAMPLE を
// 実際に含んでいることを構造的に強制する。

test('CONDITIONAL_CONSUMERS の exampleLines は正準定数 CORE_FLOW_EXAMPLE を含む行である', () => {
  const violations = [];
  for (const { label, exampleLines } of CONDITIONAL_CONSUMERS) {
    for (const line of exampleLines) {
      if (!line.includes(CORE_FLOW_EXAMPLE)) {
        violations.push(`${label}: exampleLines の行「${line}」が CORE_FLOW_EXAMPLE を含んでいない`);
      }
    }
  }
  assert.deepStrictEqual(
    violations, [],
    'exampleLines の行が正準定数 CORE_FLOW_EXAMPLE を含んでいない:\n' + violations.join('\n') + '\n\n' +
      'ここが崩れると、正準の該当例を書き換えたとき「CORE_FLOW_EXAMPLE 定数だけ直す」' +
      'ことがテストを green に戻す最小操作になり、消費側6箇所の実ファイルは旧字面のまま' +
      '放置されても検知できない（テストと実装がミラーになる #44 AC37 と同型の穴）',
  );
});

// --- U-2: 「消費側6箇所」という集合が二重列挙され、縮小が無検知 ----------------------
//
// 実測: CONDITIONAL_CONSUMERS（テスト側）と core-flow.md の「消費側」テーブルが
// 独立に列挙され、互いを検査していない。CONDITIONAL_CONSUMERS からエントリを
// 1件削って 6→5 にしても、その消費側の lines / conditionLines / exampleLines の
// 検査自体がループ対象から消えるだけなので、deepStrictEqual(missing, []) は
// 空振りして pass する（M15: 20/20 green で実測）。
//
// ⚠ 転記ミラーを作らないこと（#44 AC37 が退けたパターン）。JS 側にファイルパスの
//    配列を書いて突き合わせると、両方書き換えれば通ってしまい何も守れない。
//    必ず core-flow.md の表を実際にパースして読み取る。

const REPO_ROOT = path.join(PLUGIN_DIR, '..', '..');

/**
 * core-flow.md の「消費側」節から**表の行**だけを対象にファイルパスを抽出する。
 *
 * ⚠ 節全体を対象にしてはいけない。実測: 節の末尾に「ドリフト検出は
 * `plugins/dev-flow/agents/e2e-test-generator.test.js` の … が行う」という説明文があり、
 * これは表の行ではなく `.js` パスを含むため、節全体を正規表現で走査すると
 * テストファイル自身のパスが「7番目の消費側」として誤検出される。
 * 表の行（`| \`path\` | ... |` の形）だけに限定する。
 */
function parseCoreFlowConsumerPaths(md) {
  const sec = section(md, '## 消費側（インライン例を複製している6箇所）');
  const paths = [];
  const re = /^\|\s*`(plugins\/[^`]+\.(?:md|js))`\s*\|/gm;
  let m;
  while ((m = re.exec(sec)) !== null) {
    paths.push(m[1]);
  }
  return paths;
}

test('core-flow.md の「消費側」表と CONDITIONAL_CONSUMERS のファイル集合が一致する', () => {
  const md = read(CORE_FLOW_MD);
  const fromDoc = new Set(parseCoreFlowConsumerPaths(md));
  assert.ok(fromDoc.size > 0, 'core-flow.md の「消費側」表からファイルパスが1件も抽出できなかった');

  const fromTest = new Set(
    CONDITIONAL_CONSUMERS.map(({ file }) => path.relative(REPO_ROOT, file).split(path.sep).join('/')),
  );

  const onlyInDoc = [...fromDoc].filter((p) => !fromTest.has(p));
  const onlyInTest = [...fromTest].filter((p) => !fromDoc.has(p));

  assert.deepStrictEqual(
    { onlyInDoc, onlyInTest },
    { onlyInDoc: [], onlyInTest: [] },
    '「消費側6箇所」の集合が core-flow.md の表と CONDITIONAL_CONSUMERS（テスト側）でずれている。\n' +
      `core-flow.md にしか無い: ${JSON.stringify(onlyInDoc)}\n` +
      `CONDITIONAL_CONSUMERS にしか無い: ${JSON.stringify(onlyInTest)}\n\n` +
      'CONDITIONAL_CONSUMERS からエントリを1件削ると、その消費側への検査（lines / conditionLines / ' +
      'exampleLines）がループ対象ごと消えて空振り pass するのに、core-flow.md の表は「6箇所」と' +
      '書かれたまま矛盾に気づけない。ここで集合の一致を取ることで、片方だけを削る変異を検知する',
  );
});

// --- A-1: 消費側のインライン例が「条件(1)の場」にあることを見ていない --------------
//
// 実測: text.includes() はファイル全体を見るため、インライン例を条件(1)の場から
// 剥がしてファイル末尾の無関係なコメントへ移設しても、既存の「揃っている」検査は
// 20/20 green のままだった（M11）。指示を読むエージェントは条件(1)の場で例を
// 見られないのに、機構は沈黙する。

test('コア導線のインライン例が「条件(1)の場」（節の中）に存在する', () => {
  const missing = [];
  for (const { file, label, section: heading, exampleLines } of CONDITIONAL_CONSUMERS) {
    if (heading === null) continue; // build.workflow.js は md の節構造を持たないため対象外（上のコメント参照）
    const scoped = section(read(file), heading);
    for (const line of exampleLines) {
      if (!scoped.includes(line)) {
        missing.push(`${label}: 「${heading}」節の中にインライン例「${line}」が無い`);
      }
    }
  }
  assert.deepStrictEqual(
    missing, [],
    'インライン例が節の外（条件(1)の場から離れた場所）に退避されている疑いがある:\n' +
      missing.join('\n') +
      '\n\nファイル全体への includes() だけでは、例を無関係な場所（ファイル末尾のコメントなど）へ' +
      '移設する変異を検知できない（Issue #45 敵対的検証 A-1 で実測）',
  );
});

// --- B-1: core-flow.md への参照が消費側6箇所のどこにも無い -------------------------
//
// 実測: core-flow.md は production からの inbound 参照が0件で、消費側を編集する人が
// 正準（非該当例・迷ったときの倒し方を含む）に辿り着けない。複製されているのは
// 該当例だけで、非該当例と「迷ったら該当側に倒す」は core-flow.md にしか無い。
//
// 参照トークンをプレーンなパス文字列で
// 揃えるのは、templates/DESIGN-template.md が対象リポジトリへコピーされる雛形で、
// plugin 相対の markdown リンク（`[..](../skills/...)`）を書くとコピー先で壊れるため。
// 6箇所で1つの字面に揃えるため plugin ルート相対のプレーンパスにしている。

const CORE_FLOW_REF_TOKEN = 'skills/_shared/reference/core-flow.md';

test('消費側6箇所すべてに core-flow.md への参照がある', () => {
  const missing = [];
  for (const { file, label, section: heading } of CONDITIONAL_CONSUMERS) {
    const text = read(file);
    // section があるエントリは節の中にあることまで見る（A-1 と同じ理由。
    // 参照だけファイル末尾に置かれても、条件(1)を読んでいる人には届かない）。
    const scope = heading === null ? text : section(text, heading);
    if (!scope.includes(CORE_FLOW_REF_TOKEN)) {
      missing.push(`${label}: 参照「${CORE_FLOW_REF_TOKEN}」が無い`);
    }
  }
  assert.deepStrictEqual(
    missing, [],
    'core-flow.md への参照が消費側から欠けている:\n' + missing.join('\n') + '\n\n' +
      '参照が無いと、消費側だけを読んだ人・エージェントは該当例しか見られず、非該当例や' +
      '「迷ったら該当側に倒す」という判断の倒し方（core-flow.md にしか無い）に辿り着けない' +
      '（Issue #45 敵対的検証 B-1）',
  );
});
