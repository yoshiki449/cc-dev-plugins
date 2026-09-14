#!/usr/bin/env node
'use strict';

// enable.js の reporter パッチのテスト。
// 実行: node --test plugins/dev-flow/skills/enable-pw-reporter/scripts/enable.test.js
//
// Issue #32 の受け入れ条件に対応する。
// 「書き換えは成功したが生成物が Playwright に読めない」という静かな失敗を検出するため、
// 生成物に「裸の文字列要素」が残っていないことを毎回確認する。

const test = require('node:test');
const assert = require('node:assert');

const {
  patchReporter,
  patchConfig,
  findReporterValueRange,
  findBareReporterElements,
} = require('./enable.js');

const JSON_ENTRY_RE = /\['json', \{ outputFile: 'test-results\/results\.json' \}\]/;

// 生成物に残っている「裸の文字列要素」（Playwright が受け付けない形）を返す。
function bareElementsOf(content) {
  const range = findReporterValueRange(content);
  if (!range) return [];
  return findBareReporterElements(content, range).map((e) => e.text);
}

function config(body) {
  return (
    "import { defineConfig } from '@playwright/test';\n" +
    '\n' +
    'export default defineConfig({\n' +
    "  testDir: './tests',\n" +
    body +
    '\n' +
    "  use: { baseURL: 'http://localhost:3000' },\n" +
    '});\n'
  );
}

function countOccurrences(text, needle) {
  return text.split(needle).length - 1;
}

// --- AC1: スカラー文字列 → 配列変換でタプルに包む -------------------------

test('AC1: reporter: "html" をタプルに包んで json を追加する', () => {
  const src = config('  reporter: "html",');
  const r = patchReporter(src);

  assert.equal(r.changed, true);
  assert.match(r.content, /\["html"\]/);
  assert.match(r.content, JSON_ENTRY_RE);
  assert.deepEqual(bareElementsOf(r.content), [], '裸の文字列要素が残っている');
});

test("AC1: reporter: 'html'（シングルクォート）も同様", () => {
  const src = config("  reporter: 'html',");
  const r = patchReporter(src);

  assert.equal(r.changed, true);
  assert.match(r.content, /\['html'\]/);
  assert.deepEqual(bareElementsOf(r.content), []);
});

// --- AC3: 既に壊れている config を修復する（スキップしない）---------------

test('AC3: 破損 config（裸の文字列＋json あり）は修復される', () => {
  const src = config(
    '  reporter: [\n' +
      '    "html",\n' +
      "    ['json', { outputFile: 'test-results/results.json' }],\n" +
      '  ],',
  );
  const r = patchReporter(src);

  assert.equal(r.changed, true, 'json があるからとスキップしてはいけない');
  assert.ok(r.notes.some((n) => n.includes('repair')), `notes に修復が出ていない: ${r.notes}`);
  assert.match(r.content, /\["html"\]/);
  assert.deepEqual(bareElementsOf(r.content), []);
  assert.equal(countOccurrences(r.content, "'json'"), 1, 'json entry を二重に足している');
});

test('AC3: 裸の文字列が複数あってもすべて修復される', () => {
  const src = config(
    '  reporter: [\n' +
      "    'list',\n" +
      '    "html",\n' +
      "    ['json', { outputFile: 'test-results/results.json' }],\n" +
      '  ],',
  );
  const r = patchReporter(src);

  assert.equal(r.changed, true);
  assert.match(r.content, /\['list'\]/);
  assert.match(r.content, /\["html"\]/);
  assert.deepEqual(bareElementsOf(r.content), []);
});

test('AC3: 裸の文字列の後ろに行コメントがあってもコメントを巻き込まない', () => {
  const src = config(
    '  reporter: [\n' +
      "    ['list'],\n" +
      '    "html",  // 旧設定の残骸\n' +
      "    ['json', { outputFile: 'test-results/results.json' }],\n" +
      '  ],',
  );
  const r = patchReporter(src);

  assert.equal(r.changed, true);
  assert.match(r.content, /\["html"\],  \/\/ 旧設定の残骸/);
  assert.deepEqual(bareElementsOf(r.content), []);
});

// --- AC4: 既に正しい config は変更しない ---------------------------------

test('AC4: 正しい config には何もしない', () => {
  const src = config(
    '  reporter: [\n' +
      "    ['list'],\n" +
      "    ['html', { open: 'never', outputFolder: 'playwright-report' }],\n" +
      "    ['json', { outputFile: 'test-results/results.json' }],\n" +
      '  ],',
  );
  const r = patchReporter(src);

  // patchConfig 全体ではなく patchReporter で見る。
  // patchUseRecording は無条件に viewport 等を足すため、ファイル同一性では判定できない。
  assert.equal(r.changed, false);
  assert.equal(r.content, src);
  assert.deepEqual(r.notes, ['reporter:json already present']);
});

// --- AC5: ネストした文字列を誤ってタプル化しない --------------------------

test('AC5: オプション内の文字列（outputFolder）を壊さない', () => {
  const src = config('  reporter: [\n' + "    ['html', { outputFolder: 'playwright-report' }],\n" + '  ],');
  const r = patchReporter(src);

  assert.equal(r.changed, true, 'json entry は追加される');
  assert.ok(!r.notes.some((n) => n.includes('repair')), '修復対象ではないのに修復している');
  assert.match(r.content, /outputFolder: 'playwright-report'/);
  assert.deepEqual(bareElementsOf(r.content), []);
});

test('AC5: エスケープされたクォートを含むオプションを壊さない', () => {
  const src = config('  reporter: [\n' + '    [\'html\', { outputFolder: "a\\"b" }],\n' + '  ],');
  const r = patchReporter(src);

  assert.equal(r.changed, true);
  assert.ok(!r.notes.some((n) => n.includes('repair')));
  assert.match(r.content, /outputFolder: "a\\"b"/);
  assert.deepEqual(bareElementsOf(r.content), []);
});

test('AC5: 配列内のコメントに書かれた文字列に反応しない', () => {
  const src = config(
    '  reporter: [\n' + "    // ['html'] は一時的に無効化中\n" + "    ['list'],\n" + '  ],',
  );
  const r = patchReporter(src);

  assert.equal(r.changed, true, 'json entry は追加される');
  assert.ok(!r.notes.some((n) => n.includes('repair')), 'コメントを要素と誤認している');
  assert.deepEqual(bareElementsOf(r.content), []);
});

test('AC5: コメントアウトされた reporter 行を実定義と誤認しない', () => {
  const src = config("  // reporter: 'html',\n" + '  reporter: [\n' + "    ['list'],\n" + '  ],');
  const r = patchReporter(src);

  assert.equal(r.changed, true);
  assert.match(r.content, /\/\/ reporter: 'html',/, 'コメント行が書き換えられている');
  assert.deepEqual(bareElementsOf(r.content), []);
});

test('空配列 reporter: [] に要素の穴（elision）を作らない', () => {
  const src = config('  reporter: [],');
  const r = patchReporter(src);

  assert.equal(r.changed, true);
  // `[,` になると reporter[0] が undefined になり Playwright が読めなくなる
  assert.ok(!/reporter: \[\s*,/.test(r.content), `要素の穴ができている:\n${r.content}`);
  assert.deepEqual(bareElementsOf(r.content), []);

  const inner = /reporter: (\[[\s\S]*?\n  \])/.exec(r.content)[1];
  // eslint-disable-next-line no-eval
  const arr = eval(inner);
  assert.equal(arr.length, 1);
  assert.equal(arr[0][0], 'json');
});

// --- AC6: reporter 未定義は従来どおり ------------------------------------

test('AC6: reporter が無ければ full block を挿入する', () => {
  const src =
    "import { defineConfig } from '@playwright/test';\n\nexport default defineConfig({\n  testDir: './tests',\n});\n";
  const r = patchReporter(src);

  assert.equal(r.changed, true);
  assert.deepEqual(r.notes, ['reporter:insert full block']);
  assert.match(r.content, /\['list'\]/);
  assert.match(r.content, JSON_ENTRY_RE);
  assert.deepEqual(bareElementsOf(r.content), []);
});

// --- AC7: complex は従来どおり手動レビュー扱い ---------------------------

test('AC7: 条件式の reporter は fail にして中断する', () => {
  const src = config("  reporter: process.env.CI ? 'dot' : 'list',");
  const r = patchReporter(src);

  assert.equal(r.changed, false);
  assert.equal(r.fail, true);
  assert.equal(r.content, src);
});

// --- patchConfig 経由の統合確認 -------------------------------------------

test('patchConfig: スカラー reporter のファイル全体が裸要素ゼロになる', () => {
  const src = config('  reporter: "html",');
  const r = patchConfig(src);

  assert.equal(r.status, 'updated');
  assert.deepEqual(bareElementsOf(r.content), []);
  // use ブロックのパッチも従来どおり効く
  assert.match(r.content, /video: 'on'/);
});
