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
