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
