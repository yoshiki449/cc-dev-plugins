#!/usr/bin/env node
'use strict';

// dev-qa「起因」判定基準（Issue #52）のドリフト検出。
// 実行: node --test plugins/dev-flow/skills/_shared/scripts/qa-cause-classification.test.js
//
// 正準は _shared/reference/qa-cause-classification.md だが、qa-goal-evaluator /
// qa-technical-evaluator / qa-ux-evaluator の3エージェントの起動プロンプトへ
// そのまま埋め込む必要があり実行時に他ファイルを読めないため、各エージェント定義に
// マーカーで囲んだ複製を置いている（subagent-output-contract.test.js と同じ配り方）。
//
// 語の存在チェック（includes / 部分マッチ）は使わない。「**重要度の判定基準には
// 影響させない**」は極性に意味がある一文で、これが消えたり反転したりすると
// 「既存コードだから重要度を下げてよい」という誤った運用にQA評価が流れる
// （2026-09-16 Code-Reviewer による自己レビューが実測で指摘）。部分一致では
// 極性を守れないので、マーカーで囲んだ行を byte-identical で比較する。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const AGENTS = path.join(__dirname, '..', '..', '..', 'agents');
const REFERENCE = path.join(__dirname, '..', 'reference', 'qa-cause-classification.md');

const FILES = {
  'qa-goal-evaluator': path.join(AGENTS, 'qa-goal-evaluator.md'),
  'qa-technical-evaluator': path.join(AGENTS, 'qa-technical-evaluator.md'),
  'qa-ux-evaluator': path.join(AGENTS, 'qa-ux-evaluator.md'),
};

const read = (p) => fs.readFileSync(p, 'utf8');

/** マーカーで囲まれた部分を取り出す（インライン1行の想定なので改行境界は要求しない）。 */
function marked(md, where) {
  const re = /<!-- qa-cause-classification:rule -->([\s\S]*?)<!-- \/qa-cause-classification:rule -->/;
  const m = md.match(re);
  assert.ok(m, `${where}: qa-cause-classification:rule のマーカーが見つからない（片方だけ消していないか）`);
  return m[1];
}

test('AC1: 3エージェントのマーカー内が byte-identical である', () => {
  const bodies = Object.entries(FILES).map(([name, file]) => ({
    name,
    body: marked(read(file), name),
  }));

  const first = bodies[0];
  for (const b of bodies.slice(1)) {
    assert.strictEqual(
      b.body,
      first.body,
      `${b.name} のマーカー内が ${first.name} と食い違っている（起因ラベルの判定基準がドリフトした）`
    );
  }
});

test('AC2: 正準ファイルのマーカー内も3エージェントと一致する', () => {
  const refBody = marked(read(REFERENCE), '_shared/reference/qa-cause-classification.md').trim();
  for (const [name, file] of Object.entries(FILES)) {
    const body = marked(read(file), name).trim();
    assert.strictEqual(body, refBody, `${name} が正準ファイルと食い違っている`);
  }
});

test('AC3: 「重要度の判定基準には影響させない」の極性が残っている', () => {
  // 部分一致テストだが、AC1/AC2 が byte-identical を担保した上での「意味の固定」を兼ねる。
  // ここが消えたり否定文に変わったりすると AC1/AC2 は3ファイルとも同時に壊れるはずなので、
  // このテストだけが単独で全てを守っているわけではない（多層防御の1つ）。
  for (const [name, file] of Object.entries(FILES)) {
    const body = marked(read(file), name);
    assert.match(
      body,
      /重要度の判定基準には影響させない/,
      `${name}: 起因ラベルが重要度に影響しないという極性が失われている`
    );
  }
});
