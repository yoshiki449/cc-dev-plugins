#!/usr/bin/env node
'use strict';

// 要求の深掘り手順（Issue #74）のドリフト検出。
// 実行: node --test plugins/dev-flow/skills/_shared/scripts/requirement-elicitation.test.js
//
// 「解決策の妥当性チェック」と「終了条件」は _shared/reference/requirement-elicitation.md が正準で、
// dev-plan / auto-spec / dev-fix の SKILL.md に複製で置いている。正準だけ直して消費側が古いままだと、
// 実際にスキルを動かすのは古い方なので改善が効かないまま「直した」ことになる。
//
// 語の存在チェック（includes）は使わない。直後に否定を1文足すだけで通り抜けるので、
// マーカーで囲んだ行を byte-identical で比較する（subagent-output-contract.test.js と同じ方式）。
// 消費者リストは _shared/README.md の表から読み、テスト側に配列を持たない。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { section } = require('./md-section.js');

const SKILLS = path.join(__dirname, '..', '..');
const REFERENCE = path.join(SKILLS, '_shared', 'reference', 'requirement-elicitation.md');
const README = path.join(SKILLS, '_shared', 'README.md');
const CONSUMER_SECTION = '## 要求の深掘り手順の消費者';

const read = (p) => fs.readFileSync(p, 'utf8');
const skillMd = (name) => path.join(SKILLS, name, 'SKILL.md');

/** マーカーで囲まれた行を取り出す。行頭のインデントは落とす（消費側は箇条書きの中にネストされる）。 */
function marked(md, name, where) {
  const re = new RegExp(`<!-- ${name} -->\\n([\\s\\S]*?)\\n[ \\t]*<!-- /${name} -->`);
  const m = md.match(re);
  assert.ok(m, `${where}: ${name} のマーカーが見つからない（片方だけ消していないか）`);
  return m[1].split('\n').map((l) => l.replace(/^\s+/, '')).filter(Boolean);
}

function consumers() {
  return section(read(README), CONSUMER_SECTION)
    .split('\n')
    .map((l) => l.match(/^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|/))
    .filter(Boolean)
    .map((m) => ({ skill: m[1], alternative: m[2], exit: m[3] }));
}

test('AC1: 消費者表が3件・重複なしで、要求を受け取る入口3つを過不足なく持つ', () => {
  const names = consumers().map((c) => c.skill).sort();
  // allowlist。件数だけだと、1行を別スキルに差し替えても通り、差し替えられた入口が検査から消える。
  assert.deepEqual(names, ['auto-spec', 'dev-fix', 'dev-plan']);
});

for (const kind of ['alternative', 'exit']) {
  test(`AC2(${kind}): 全消費者の該当節が正準と byte-identical である`, () => {
    const canonical = marked(read(REFERENCE), `requirement-elicitation:${kind}`, 'reference');
    for (const c of consumers()) {
      const body = section(read(skillMd(c.skill)), c[kind]);
      assert.deepEqual(
        marked(body, `requirement-elicitation:${kind}`, `${c.skill} / ${c[kind]}`),
        canonical,
        `${c.skill} の ${kind} が reference と食い違っている。両方を同時に直すこと`
      );
    }
  });
}

test('AC3: 正準の妥当性チェックが「ユーザーに選ばせ、元の案を尊重する」極性を保っている', () => {
  // AC2 は全ファイルを同時に反転されると通るので、正準側の極性をここで固定する。
  const lines = marked(read(REFERENCE), 'requirement-elicitation:alternative', 'reference');
  assert.equal(lines.length, 3, 'alternative は3行のはず（行を足して打ち消す変更を検知する）');
  assert.match(lines[0], /元の案と代替案を並べて AskUserQuestion で選んでもらう$/);
  assert.match(lines[1], /^- 元の案が選ばれたら、その判断を記録してそのまま進める$/);
  assert.match(lines[2], /^- Claude が代替案で勝手に進めてはならない$/);
});

test('AC4: 正準の終了条件が「復唱への合意」と「未クローズで進まない」を持つ', () => {
  const lines = marked(read(REFERENCE), 'requirement-elicitation:exit', 'reference');
  assert.equal(lines.length, 4, 'exit は4行のはず');
  assert.match(lines[0], /項目を復唱してユーザーに合っているかを確認する。/);
  // 本文に書いた復唱はダイアログを開いている間見えない（試運用で「表が見えません」と返り、合意の確認を1回やり直した）
  assert.match(lines[0], /復唱の全文は AskUserQuestion のダイアログの中（question 文か選択肢の preview）に入れる。合意が取れたら終了し/);
  assert.match(lines[1], /質問はせず復唱1回で終える$/);
  assert.match(lines[2], /^- 3往復しても埋まらない項目は/);
  assert.match(lines[3], /次の手順へ進んではならない$/);
});

test('AC5: dev-plan の A1.8 要求の確定が A1.5 の後・A2 の前にある', () => {
  const md = read(skillMd('dev-plan'));
  const a15 = md.indexOf('\n### A1.5. ');
  const a18 = md.indexOf('\n### A1.8. 要求の確定');
  const a2 = md.indexOf('\n### A2. ');
  assert.ok(a15 !== -1 && a18 !== -1 && a2 !== -1, 'A1.5 / A1.8 / A2 の見出しが揃っていない');
  assert.ok(a15 < a18 && a18 < a2, `A1.8 は A1.5 と A2 の間に置く（A1.5=${a15} A1.8=${a18} A2=${a2}）`);
});

test('AC6: dev-fix の分類表が4分類を過不足なく持つ', () => {
  const rows = marked(read(skillMd('dev-fix')), 'dev-fix:elicitation-items', 'dev-fix')
    .filter((l) => l.startsWith('|') && !/^\|\s*(分類|-+)\s*\|/.test(l))
    .map((l) => l.split('|')[1].trim());
  // allowlist。バグ・テスト修復の行が消えると、その分類で要求を確かめる手順が無くなる（#74 の判断 #3）。
  assert.deepEqual(rows, ['仕様追加・UI改善', 'バグ・仕様不一致', 'テスト修復', '履歴整理']);
});

test('AC7: dev-fix のテスト修復行が「テストと実装のどちらが正しいか」を確定させる', () => {
  const row = marked(read(skillMd('dev-fix')), 'dev-fix:elicitation-items', 'dev-fix').find((l) =>
    l.startsWith('| テスト修復 |')
  );
  assert.match(row, /^\| テスト修復 \| 正しいのはテストの期待値か実装か \| skip・リトライ・待ち時間延長・期待値の書き換えを選ぶ前にする \|$/);
});

test('AC8: Issue テンプレートが要求カードを必須セクションとして持つ', () => {
  const tpl = read(path.join(SKILLS, 'dev-plan', 'reference', 'issue-template.md'));
  const card = section(tpl, '## 要求カード');
  for (const item of ['目的', '現状の困りごと', '成功を観察する条件', 'スコープ外', '制約']) {
    assert.match(card, new RegExp(`^\\| ${item} \\|`, 'm'), `要求カードに ${item} の行が無い`);
  }
  assert.match(section(tpl, '## 必ず含めるセクション'), /^- 要求カード（/m);
});

test('AC9: 全消費者から reference へのリンクが生きている', () => {
  for (const c of consumers()) {
    const m = read(skillMd(c.skill)).match(/\]\((\.\.\/_shared\/reference\/requirement-elicitation\.md)\)/);
    assert.ok(m, `${c.skill}: reference へのリンクが SKILL.md に無い`);
    assert.ok(fs.existsSync(path.join(SKILLS, c.skill, m[1])), `${c.skill}: リンク先が存在しない`);
  }
});

// ---- 問いの書式（question-format）・論点の仕分け（triage）・本文に書いてよいもの（evidence） ----
// 3つとも正準は reference、複製先は README の「問いの書式・論点の仕分け・本文に書いてよいものの消費者」表。

const PLUGIN = path.join(SKILLS, '..');
const KINDS = ['question-format', 'triage', 'evidence'];
const CONSUMER2_SECTION = '## 問いの書式・論点の仕分け・本文に書いてよいものの消費者';

function consumers2() {
  return section(read(README), CONSUMER2_SECTION)
    .split('\n')
    .map((l) => l.match(/^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|/))
    .filter(Boolean)
    .map((m) => ({ file: m[1], 'question-format': m[2], triage: m[3], evidence: m[4] }));
}

const canonicalLines = (kind) => marked(read(REFERENCE), `requirement-elicitation:${kind}`, 'reference');

function mdFilesUnder(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' || e.name === 'fixtures' ? [] : mdFilesUnder(p);
    return e.name.endsWith('.md') ? [p] : [];
  });
}

test('AC10: 消費者表2の対象ファイルが allowlist と一致する', () => {
  // allowlist。denylist（「このファイルが無いこと」）だと、別のファイルに複製が置かれた瞬間に素通りする。
  const files = consumers2().map((c) => c.file).sort();
  assert.deepEqual(files, [
    'agents/designer.md',
    'agents/spec-writer.md',
    'skills/auto-design/SKILL.md',
    'skills/auto-spec/SKILL.md',
    'skills/dev-fix/SKILL.md',
    'skills/dev-plan/SKILL.md',
  ]);
});

for (const kind of KINDS) {
  test(`AC11(${kind}): 表に載る全ファイルの該当節が正準と byte-identical で、表に無いファイルは複製を持たない`, () => {
    const canonical = canonicalLines(kind);
    const listed = new Set();
    for (const c of consumers2()) {
      const md = read(path.join(PLUGIN, c.file));
      const marker = `<!-- requirement-elicitation:${kind} -->`;
      const count = md.split(marker).length - 1;
      if (c[kind] === '-') {
        assert.equal(count, 0, `${c.file} は ${kind} を持たない行なのにマーカーがある`);
        continue;
      }
      assert.equal(count, 1, `${c.file}: ${kind} のマーカーが ${count} 個（1個のはず）`);
      listed.add(path.resolve(PLUGIN, c.file));
      assert.deepEqual(
        marked(section(md, c[kind]), `requirement-elicitation:${kind}`, `${c.file} / ${c[kind]}`),
        canonical,
        `${c.file} の ${kind} が reference と食い違っている。両方を同時に直すこと`
      );
    }
    // 表に載せていない場所に複製が増えると、正準を直しても古いまま動く。
    const stray = mdFilesUnder(PLUGIN)
      .filter((f) => f !== REFERENCE && read(f).includes(`<!-- requirement-elicitation:${kind} -->`))
      .filter((f) => !listed.has(f));
    assert.deepEqual(stray, [], `表に無いファイルに ${kind} の複製がある`);
  });
}

test('AC12: 正準の問いの書式が「推奨案を先頭・根拠必須・根拠が無ければ作らない」を持つ', () => {
  const lines = canonicalLines('question-format');
  assert.equal(lines.length, 3, 'question-format は3行のはず（行を足して打ち消す変更を検知する）');
  assert.match(lines[0], /^- 質問には「推奨案」「根拠」「選択肢」を付ける。推奨案は選択肢の先頭に置き、ラベルの末尾に「\(Recommended\)」を付ける$/);
  assert.match(lines[1], /根拠が推測だけなら「推測」と明記する$/);
  assert.match(lines[2], /推奨案を無理に作らず「推奨なし（判断材料が無い）」と明記し/);
});

test('AC13: 正準の論点の仕分けが「高の基準3つ・迷ったら高・後工程送りは承認必須・0件文書では使わない」を持つ', () => {
  const lines = canonicalLines('triage');
  assert.equal(lines.length, 5, 'triage は5行のはず');
  assert.match(lines[0], /「工程」（その論点を決めるべき工程: 要件定義／設計／実装／運用）と「優先度」（高／中／低）を付け、質問の先頭に「工程: ○○／優先度: △△」と書く/);
  for (const criterion of ['回答が無いと次の工程に着手できない', '後で覆ると手戻りが大きい', '事業・法務・契約上、進める前の合意が必須']) {
    assert.ok(lines[1].includes(criterion), `優先度「高」の基準「${criterion}」が無い`);
  }
  assert.match(lines[1], /判定に迷ったら「高」にする。「高」から下げるときは、3つのどれにも当たらない理由を1行書く$/);
  assert.match(lines[2], /^- 優先度「高」の論点と、いま進めている工程以前の論点は、その場で決める。決めずに次の手順へ進んではならない$/);
  assert.match(lines[3], /優先度が「高」でないものだけを「後工程送り」にできる。/);
  assert.match(lines[3], /承認済み保留と同じ4点（理由／いつ誰が決めるか／暫定案／影響範囲）を1件1行の表にして、まとめて1回の AskUserQuestion で承認を取る。暫定案は本文に書かない$/);
  assert.match(lines[4], /確定時に Open Questions を0件にする文書（REQUIREMENTS\.md・DESIGN\.md）では使わず/);
});

test('AC14: 正準の evidence が「列挙にないものは本文に書かない」の allowlist 形になっている', () => {
  const lines = canonicalLines('evidence');
  assert.equal(lines.length, 4, 'evidence は4行のはず');
  assert.match(lines[0], /根拠が次の3つのどれかで、出典を示せる事項だけ。①ユーザーの発言・回答 ②読んだ・実行した結果（ファイルと行、コマンドと出力） ③ユーザーが合意した判断$/);
  assert.match(lines[1], /^- 3つのどれでもない事項は本文に書かない。/);
  assert.match(lines[1], /問いにして、答えが返るまで本文へ入れない$/);
  assert.match(lines[2], /^- 「暫定案」「想定」「仮定」「一般的にはこう」は根拠にならない。暫定案は未解決事項の暫定案欄にだけ書き、本文には書かない$/);
  assert.match(lines[3], /示せないものは本文から外して問いに戻す$/);
});

test('AC15: dev-plan A7 の投稿前 grep が、正準 evidence の検索語をすべて含む', () => {
  const words = canonicalLines('evidence')[3].match(/『([^』]+)』/)[1].split('／');
  assert.ok(words.length >= 11, `検索語が ${words.length} 語しか取れない（正規表現の破損を疑う）`);
  const a7 = section(read(skillMd('dev-plan')), '### A7. Issue 作成');
  const grep = a7.match(/`grep -nE '([^']+)'/);
  assert.ok(grep, 'A7 に grep -nE の実行例が無い');
  const pattern = grep[1].split('|');
  for (const w of words) assert.ok(pattern.includes(w), `A7 の grep に「${w}」が無い（正準と検索語がずれている）`);
});

test('AC16: Open Questions の項目書式が工程・優先度・推奨案・根拠・選択肢を持つ（agent と雛形の全6か所）', () => {
  const places = [
    ['agents/spec-writer.md', '## 9. Open Questions'],
    ['agents/designer.md', '## 12. Open Questions'],
    ['templates/REQUIREMENTS-template.md', '## 9. Open Questions'],
    ['templates/DESIGN-template.md', '## 12. Open Questions'],
  ];
  for (const [file, heading] of places) {
    const body = section(read(path.join(PLUGIN, file)), heading);
    assert.match(body, /^- \[ \] Q1: <質問>（工程: <要件定義\|設計\|実装\|運用>／優先度: <高\|中\|低>）$/m, `${file}: Q1 の見出し行が書式と違う`);
    assert.match(body, /^ {2}- 推奨案: <案>　根拠: <.*「推測」.*「推奨なし（判断材料が無い）」>$/m, `${file}: 推奨案・根拠の行が無い`);
    assert.match(body, /^ {2}- 選択肢: A\) <案> B\) <案>$/m, `${file}: 選択肢の行が無い`);
    assert.doesNotMatch(section(read(path.join(PLUGIN, file)), heading.split('.')[0] + '. Open Questions'), /推測した箇所/, `${file}: 見出しに「推測した箇所」が残っている`);
  }
});

test('AC17: agent の禁止事項が「根拠のない事項を本文に書くこと」を禁じ、旧文言を残していない', () => {
  const designer = section(read(path.join(PLUGIN, 'agents', 'designer.md')), '## 禁止事項');
  assert.match(designer, /^- 根拠の3種類のどれでもない判断を、Open Questions に載せずに本文へ書くこと$/m);
  assert.doesNotMatch(designer, /Open Questions に逃さず/, '旧文言（Open Questions に逃さず〜勝手に判断）が残っている。読み方によっては「勝手に判断せよ」に読める');
  const spec = section(read(path.join(PLUGIN, 'agents', 'spec-writer.md')), '## 禁止事項');
  assert.match(spec, /^- 根拠の3種類のどれでもない事項を本文に書くこと/m);
});

test('AC18: dev-plan A6 の「計画が立っていないサイン」は優先度「高」の承認済み保留だけを数える', () => {
  const a6 = section(read(skillMd('dev-plan')), '### A6. 設計レビュー');
  assert.match(a6, /優先度「高」の承認済み保留が3件以上出るなら計画がまだ立っていないサイン/);
  // 後工程送りが正常な経路になったので、全保留を数えると正常な計画を差し戻す。
  assert.doesNotMatch(a6, /(?<!「高」の)承認済み保留が3件以上/);
});

test('AC19: auto-spec / auto-design の確定基準が、本文の全記述に根拠があることを求める', () => {
  for (const [skill, sec] of [['auto-spec', '## 確定の判断基準'], ['auto-design', '## 確定の判断基準']]) {
    assert.match(section(read(skillMd(skill)), sec), /^- 本文の記述すべてが、.*「本文に書いてよいもの」の根拠（ユーザーの発言・実測・合意した判断）のどれかに紐づくこと$/m, `${skill}: 確定基準に根拠の要件が無い`);
  }
});
