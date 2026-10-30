#!/usr/bin/env node
'use strict';

// UI/UX チェックリストの整合検査。
// 実行: node --test plugins/dev-flow/skills/_shared/scripts/ui-ux-checklist.test.js
//
// 正準は _shared/reference/ui-ux-checklist.md で、qa-ux-evaluator / qa-explorer / ui-designer の3 agent が
// 「ui-ux-checklist:apply」マーカーの一文を byte-identical で複製して持つ（agent は単独で動き、
// reference を読まない前提のため）。語の存在チェックだと指示を反転しても通るので、マーカー内の行を比較する。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PLUGIN = path.join(__dirname, '..', '..', '..');
const REFERENCE = path.join(PLUGIN, 'skills', '_shared', 'reference', 'ui-ux-checklist.md');
const CONSUMERS = ['qa-ux-evaluator', 'qa-explorer', 'ui-designer'];

const read = (p) => fs.readFileSync(p, 'utf8');
const agent = (name) => path.join(PLUGIN, 'agents', `${name}.md`);

function marked(md, where) {
  const m = md.match(/<!-- ui-ux-checklist:apply -->\n([\s\S]*?)\n[ \t]*<!-- \/ui-ux-checklist:apply -->/);
  assert.ok(m, `${where}: ui-ux-checklist:apply のマーカーが見つからない`);
  return m[1].split('\n').map((l) => l.trim()).filter(Boolean);
}

function items() {
  return [...read(REFERENCE).matchAll(/^\| ([A-Z]\d+) \| (\S+) \| (\S+) \| (.+) \|$/gm)].map((m) => ({
    id: m[1], kind: m[2], level: m[3], text: m[4],
  }));
}

test('AC1: 全項目が一意の ID・区分(画/操/設)・強度(必須/推奨)・本文を持つ', () => {
  const list = items();
  assert.ok(list.length >= 40, `項目が少なすぎる: ${list.length}`);
  assert.equal(new Set(list.map((i) => i.id)).size, list.length, 'ID が重複している');
  for (const i of list) {
    assert.ok(['画', '操', '設'].includes(i.kind), `${i.id}: 区分が不正 (${i.kind})`);
    assert.ok(['必須', '推奨'].includes(i.level), `${i.id}: 強度が不正 (${i.level})`);
    assert.ok(i.text.length > 10, `${i.id}: 本文が短すぎる`);
  }
});

test('AC2: 必須と推奨が両方あり、3区分すべてに項目がある', () => {
  const list = items();
  for (const k of ['画', '操', '設']) assert.ok(list.some((i) => i.kind === k), `区分 ${k} の項目がない`);
  for (const l of ['必須', '推奨']) assert.ok(list.some((i) => i.level === l), `強度 ${l} の項目がない`);
});

test('AC3: 3 agent のマーカーが正準と byte-identical である', () => {
  const canonical = marked(read(REFERENCE), 'reference');
  for (const name of CONSUMERS) {
    assert.deepEqual(
      marked(read(agent(name)), name),
      canonical,
      `${name} の ui-ux-checklist:apply が reference と食い違っている。両方を同時に直すこと`,
    );
  }
});

test('AC4: 3 agent が reference のパスを持つ', () => {
  for (const name of CONSUMERS) {
    assert.ok(read(agent(name)).includes('skills/_shared/reference/ui-ux-checklist.md'), `${name}: reference へのパスがない`);
  }
});

test('AC5: qa-ux-evaluator の出力形式が項目ID列を持ち、対象外項目の読み込み元(DESIGN.md)を入力に持つ', () => {
  const md = read(agent('qa-ux-evaluator'));
  assert.match(md, /\| # \| 重要度 \| 分類 \| 項目ID \|/);
  assert.match(md, /docs\/DESIGN\.md.*対象外項目と理由/);
});

test('AC6: 正準の1文が判定の4値と素通り禁止を持つ', () => {
  const line = marked(read(REFERENCE), 'reference').join('');
  for (const w of ['OK', 'NG', '対象外', '判定不可', '黙って素通りしない']) assert.ok(line.includes(w), `正準に「${w}」がない`);
});
