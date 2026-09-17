#!/usr/bin/env node
'use strict';

// feedback-fix.workflow.js の E2E テスト漏れルーティング（dev-test-ledger の🔴「テスト層: 運用」／
// QA 指摘を e2e-test-generator 経由で埋める導線）のドリフト検出。
// 実行: node --test plugins/dev-flow/workflows/test-gap-routing.test.js
//
// なぜ必要か:
//   ワークフロー本体（*.workflow.js）は Workflow ランタイムが注入するグローバル（agent/phase/args 等）
//   に依存して動くため、node --test で require して実行することができない（他の *.workflow.js にも
//   require() が無いのはこのため。build.workflow.js も同様の自己完結スクリプト）。
//   そのためここでは model-routing.test.js と同じ方式（ソーステキストを読んで検証する）を取る。
//
//   検出したい欠陥は3つ:
//   1. FEEDBACK_ITEMS_SCHEMA / FIX_PLAN_SCHEMA の category enum から 'test-gap' が消える
//      （feedback-interpreter が test-gap を返しても StructuredOutput のバリデーションで弾かれ、
//       常に bug 等へ丸められて再現しなくなる）
//   2. FixLoop の分岐条件（category === 'test-gap' && test_layer === '運用'）や
//      e2e-test-generator 呼び出しが消える（テスト漏れが implementer に流れ、通常の一般実装で
//      その場しのぎにされる。dev-verify D3 が既定で生成しないユーザーストーリー/機能テストを
//      埋める唯一の導線が消える）
//   3. 参照用 JSON（workflows/schemas/*.json）とインライン schema の enum がズレる
//      （ランタイムは埋め込み側を読むため、JSON だけ直しても効かず、ドキュメントとしても嘘になる）
//
// 落ちたときの直し方:
//   1・3 は enum 配列に 'test-gap' / test_layer を足し直す（インライン・JSON 両方）。
//   2 は FixLoop の分岐そのものを復元する。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const WORKFLOW_JS = path.join(__dirname, 'feedback-fix.workflow.js');
const FEEDBACK_ITEMS_JSON = path.join(__dirname, 'schemas', 'feedback-items.json');
const FIX_PLAN_JSON = path.join(__dirname, 'schemas', 'fix-plan.json');

const read = (p) => fs.readFileSync(p, 'utf8');

/** `const NAME = { ... }` のブレース対応が取れた範囲を取り出す（文字列内の { } は含まない想定の簡潔な schema 定義専用）。 */
function extractConstBlock(src, constName) {
  const marker = `const ${constName} = {`;
  const start = src.indexOf(marker);
  assert.ok(start !== -1, `${constName} が見つからない（削除・リネームされていないか）`);
  let depth = 0;
  let i = start + marker.length - 1; // '{' の位置
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }
  assert.notStrictEqual(depth, undefined);
  return src.slice(start, i);
}

/** ブロック内で最初に現れる `<propName>: { ... enum: [...] ... }` の enum 配列を取り出す。 */
function extractEnum(block, propName, where) {
  const re = new RegExp(`\\b${propName}\\s*:\\s*\\{[^}]*?enum:\\s*\\[([^\\]]+)\\]`);
  const m = block.match(re);
  assert.ok(m, `${where}: ${propName} の enum が見つからない`);
  return m[1]
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

const workflowSrc = read(WORKFLOW_JS);

test('FEEDBACK_ITEMS_SCHEMA の category enum に test-gap がある', () => {
  const block = extractConstBlock(workflowSrc, 'FEEDBACK_ITEMS_SCHEMA');
  const categories = extractEnum(block, 'category', 'FEEDBACK_ITEMS_SCHEMA');
  assert.ok(categories.includes('test-gap'), 'test-gap が category enum から消えている');
  // 既存カテゴリを消していないことも確認する（足すつもりで置換してしまう事故を検知）
  for (const c of ['bug', 'ui-improvement', 'spec-mismatch', 'spec-addition', 'performance', 'a11y', 'security']) {
    assert.ok(categories.includes(c), `既存カテゴリ ${c} が消えている`);
  }
});

test('FEEDBACK_ITEMS_SCHEMA が test_layer プロパティを持つ（運用/機能などのテスト層）', () => {
  const block = extractConstBlock(workflowSrc, 'FEEDBACK_ITEMS_SCHEMA');
  const layers = extractEnum(block, 'test_layer', 'FEEDBACK_ITEMS_SCHEMA');
  assert.deepEqual(layers.sort(), ['クロスブラウザ', 'セキュリティ', 'ユーザー視点', '機能', '運用', '性能'].sort());
});

test('FIX_PLAN_SCHEMA が category / test_layer を転記できる（e2e-test-generator への振り分けに必要）', () => {
  const block = extractConstBlock(workflowSrc, 'FIX_PLAN_SCHEMA');
  const categories = extractEnum(block, 'category', 'FIX_PLAN_SCHEMA');
  assert.ok(categories.includes('test-gap'), 'FIX_PLAN_SCHEMA.category に test-gap が無い');
  const layers = extractEnum(block, 'test_layer', 'FIX_PLAN_SCHEMA');
  assert.ok(layers.includes('運用'), 'FIX_PLAN_SCHEMA.test_layer に 運用 が無い');
});

test('参照用 JSON（feedback-items.json / fix-plan.json）の enum がインライン schema と一致する', () => {
  const feedbackBlock = extractConstBlock(workflowSrc, 'FEEDBACK_ITEMS_SCHEMA');
  const fixPlanBlock = extractConstBlock(workflowSrc, 'FIX_PLAN_SCHEMA');

  const feedbackJson = JSON.parse(read(FEEDBACK_ITEMS_JSON));
  const fixPlanJson = JSON.parse(read(FIX_PLAN_JSON));

  assert.deepEqual(
    feedbackJson.properties.items.items.properties.category.enum.slice().sort(),
    extractEnum(feedbackBlock, 'category', 'feedback-items.json').sort(),
    'feedback-items.json の category enum がインライン schema とズレている'
  );
  assert.deepEqual(
    feedbackJson.properties.items.items.properties.test_layer.enum.slice().sort(),
    extractEnum(feedbackBlock, 'test_layer', 'feedback-items.json').sort(),
    'feedback-items.json の test_layer enum がインライン schema とズレている'
  );
  assert.deepEqual(
    fixPlanJson.properties.items.items.properties.category.enum.slice().sort(),
    extractEnum(fixPlanBlock, 'category', 'fix-plan.json').sort(),
    'fix-plan.json の category enum がインライン schema とズレている'
  );
  assert.deepEqual(
    fixPlanJson.properties.items.items.properties.test_layer.enum.slice().sort(),
    extractEnum(fixPlanBlock, 'test_layer', 'fix-plan.json').sort(),
    'fix-plan.json の test_layer enum がインライン schema とズレている'
  );
});

test('FixLoop が category=test-gap かつ test_layer=運用 を e2e-test-generator に分岐させている', () => {
  assert.match(
    workflowSrc,
    /item\.category === 'test-gap' && item\.test_layer === '運用'/,
    '分岐条件が見つからない（implementer 一本化に戻されていないか）'
  );
  assert.match(
    workflowSrc,
    /agentType:\s*'dev-flow:e2e-test-generator'/,
    'FixLoop から e2e-test-generator への呼び出しが見つからない'
  );
  // implementer 分岐（test-gap 以外の既存経路）も残っていること
  assert.match(
    workflowSrc,
    /agentType:\s*'dev-flow:implementer'/,
    'implementer 分岐が消えている（test-gap 以外の項目が処理できなくなる）'
  );
});

test('RePlan が FeedbackItems の category/test_layer を FixPlan へ転記する指示を持つ', () => {
  const idx = workflowSrc.indexOf("以下の FeedbackItems を FixPlan に変換してください");
  assert.notStrictEqual(idx, -1, 'RePlan の呼び出しプロンプトが見つからない');
  const prompt = workflowSrc.slice(idx, idx + 500);
  assert.match(prompt, /category\s*\/\s*test_layer/, 'RePlan の指示に category/test_layer の転記が無い（e2e 分岐が空振りする）');
});
