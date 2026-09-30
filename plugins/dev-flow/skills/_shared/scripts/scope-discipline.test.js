#!/usr/bin/env node
'use strict';

// スコープ規律の一文のドリフト検出。
// 実行: node --test plugins/dev-flow/skills/_shared/scripts/scope-discipline.test.js
//
// 正準は _shared/reference/scope-discipline.md で、dev-implement / dev-fix / dev-loop の SKILL.md に
// 複製で置いている。実際にメインセッションが読むのは消費側なので、正準だけ直すと改善が効かない。
// 語の存在チェックは否定を1文足すだけで通り抜けるので、マーカー内の行を byte-identical で比較する。
// 消費者リストは _shared/README.md の表から読み、テスト側に配列を持たない。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { section } = require('./md-section.js');

const SKILLS = path.join(__dirname, '..', '..');
const REFERENCE = path.join(SKILLS, '_shared', 'reference', 'scope-discipline.md');
const README = path.join(SKILLS, '_shared', 'README.md');
const CONSUMER_SECTION = '## スコープ規律の消費者';

const read = (p) => fs.readFileSync(p, 'utf8');
const skillMd = (name) => path.join(SKILLS, name, 'SKILL.md');

function marked(md, where) {
  const m = md.match(/<!-- scope-discipline -->\n([\s\S]*?)\n[ \t]*<!-- \/scope-discipline -->/);
  assert.ok(m, `${where}: scope-discipline のマーカーが見つからない`);
  return m[1].split('\n').map((l) => l.replace(/^\s+/, '')).filter(Boolean);
}

function consumers() {
  return section(read(README), CONSUMER_SECTION)
    .split('\n')
    .map((l) => l.match(/^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|/))
    .filter(Boolean)
    .map((m) => ({ skill: m[1], section: m[2] }));
}

test('AC1: 消費者表が実装・修正を進める3スキルを過不足なく持つ', () => {
  assert.deepEqual(consumers().map((c) => c.skill).sort(), ['dev-fix', 'dev-implement', 'dev-loop']);
});

test('AC2: 全消費者の該当節が正準と byte-identical である', () => {
  const canonical = marked(read(REFERENCE), 'reference');
  for (const c of consumers()) {
    assert.deepEqual(
      marked(section(read(skillMd(c.skill)), c.section), `${c.skill} / ${c.section}`),
      canonical,
      `${c.skill} のスコープ規律が reference と食い違っている。両方を同時に直すこと`,
    );
  }
});

test('AC3: 正準が「範囲を黙って変えない」「未完了を完了と言わない」を保っている', () => {
  // AC2 は全ファイル同時の反転を通すので、正準側の極性をここで固定する。
  const lines = marked(read(REFERENCE), 'reference');
  assert.equal(lines.length, 3, '正準は3行のはず（打ち消しの行を足す変更を検知する）');
  assert.match(lines[0], /^- 頼まれた範囲で仕上げる。/);
  assert.match(lines[1], /一文で伝え、依頼どおりに進める。範囲を黙って広げも狭めもしない$/);
  assert.match(lines[2], /^- 終わっていない部分があれば完了と言わず、/);
});

test('AC4: 全消費者から reference へのリンクが生きている', () => {
  for (const c of consumers()) {
    const m = read(skillMd(c.skill)).match(/\]\((\.\.\/_shared\/reference\/scope-discipline\.md)\)/);
    assert.ok(m, `${c.skill}: reference へのリンクが無い`);
    assert.ok(fs.existsSync(path.join(SKILLS, c.skill, m[1])), `${c.skill}: リンク先が存在しない`);
  }
});

test('AC5: 統合済みの dev-videos はモデルから自動起動しない', () => {
  // dev-hub と同じ依頼で発火すると案内ページを経由して1往復失う。スラッシュコマンドとしては残す。
  const fm = read(skillMd('dev-videos')).split('\n---\n')[0];
  assert.match(fm, /^disable-model-invocation: true$/m);
  assert.doesNotMatch(fm, /^user-invocable: false$/m);
});

// ---- 仕様に無い、ユーザーに見える挙動の例外（scope-discipline-gap / scope-discipline-gap-loop） ----
// 範囲規律の一文の「曖昧な点は解釈する」だけでは、文言・並び順のように作業量が変わらない細部が確認から漏れる。
// 例外は範囲規律の一文を変えずに重ねる。dev-loop は途中で止まらないので別文（記録して境界確認で提示）。

function markedBy(md, name, where) {
  const m = md.match(new RegExp(`<!-- ${name} -->\\n([\\s\\S]*?)\\n[ \\t]*<!-- /${name} -->`));
  assert.ok(m, `${where}: ${name} のマーカーが見つからない`);
  return m[1].split('\n').map((l) => l.replace(/^\s+/, '')).filter(Boolean);
}

const GAP_KIND = { 'dev-implement': 'scope-discipline-gap', 'dev-fix': 'scope-discipline-gap', 'dev-loop': 'scope-discipline-gap-loop' };

test('AC5: 例外ブロックの持ち主が、範囲規律の消費者と過不足なく対応している', () => {
  // 新しい消費者を範囲規律の表に足したら、どちらの例外を持つかを決めさせる（この対応表を更新させる）。
  assert.deepEqual(consumers().map((c) => c.skill).sort(), Object.keys(GAP_KIND).sort());
});

test('AC6: 全消費者の例外ブロックが正準と byte-identical で、取り違えていない', () => {
  for (const c of consumers()) {
    const kind = GAP_KIND[c.skill];
    const other = kind === 'scope-discipline-gap' ? 'scope-discipline-gap-loop' : 'scope-discipline-gap';
    const body = section(read(skillMd(c.skill)), c.section);
    assert.deepEqual(markedBy(body, kind, c.skill), markedBy(read(REFERENCE), kind, 'reference'), `${c.skill} の ${kind} が reference と食い違っている`);
    assert.ok(!body.includes(`<!-- ${other} -->`), `${c.skill} に ${other} が混ざっている（止まる版と記録する版の取り違え）`);
  }
});

test('AC7: 正準の例外が「見える挙動は解釈せず、上の一文より優先」の極性を持つ', () => {
  const gap = markedBy(read(REFERENCE), 'scope-discipline-gap', 'reference');
  assert.equal(gap.length, 3);
  assert.match(gap[0], /上の「曖昧な点は解釈する」の対象外。解釈して進めず、その場で止めて AskUserQuestion で聞く。この行は上の一文より優先する$/);
  assert.match(gap[1], /^- 質問には推奨案と根拠を付ける/);
  assert.match(gap[2], /^- ユーザーに見えない内部の判断/);
  const loop = markedBy(read(REFERENCE), 'scope-discipline-gap-loop', 'reference');
  assert.equal(loop.length, 3);
  assert.match(loop[0], /dev-loop は途中で止まらないので、暫定案で進め、進捗ファイルの `## 要確認` に「判断内容／暫定案／根拠」を1件1行で追記する。この行は上の一文より優先する$/);
  assert.match(loop[1], /L1\.5d の AskUserQuestion の本文に全件を転記し、「完了」を選ぶ前に各件がユーザーの意図に合っているかを確認する/);
});

test('AC8: dev-loop の進捗ファイルと境界確認が「要確認」を受け止める', () => {
  const md = read(skillMd('dev-loop'));
  assert.match(md, /^## 要確認（仕様に無い、ユーザーに見える挙動の暫定案。/m, '進捗ファイルの雛形に ## 要確認 が無い');
  assert.match(section(md, '#### L1.5d 境界確認 AskUserQuestion'), /\*\*要確認の提示\*\*: 進捗ファイルの `## 要確認` が1件以上あるときは、AskUserQuestion の本文に全件/);
});

test('AC9: 範囲規律の正準の文（曖昧な点の扱い）は変えていない', () => {
  // 例外は重ねるだけで、Anthropic の移行ガイド由来の一文そのものは触らない。
  assert.deepEqual(marked(read(REFERENCE), 'reference'), [
    '- 頼まれた範囲で仕上げる。曖昧な点は注意深い同僚のように解釈し、読み方によって作業が大きく変わるときだけ確認する',
    '- より良い方法があると判断したら一文で伝え、依頼どおりに進める。範囲を黙って広げも狭めもしない',
    '- 終わっていない部分があれば完了と言わず、終えた部分と、残りとその理由を書く',
  ]);
});

