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

// ---- G 群（HTML 標準部品・デザインシステムの扱い） ----
// 正準の1文は「ui-ux-checklist:parts-policy」マーカー。3 agent が byte-identical で複製する。

function policyMarked(md, where) {
  const m = md.match(/<!-- ui-ux-checklist:parts-policy -->\n([\s\S]*?)\n[ \t]*<!-- \/ui-ux-checklist:parts-policy -->/);
  assert.ok(m, `${where}: ui-ux-checklist:parts-policy のマーカーが見つからない`);
  return m[1].split('\n').map((l) => l.trim()).filter(Boolean);
}

test('AC7: 3 agent の parts-policy マーカーが正準と byte-identical である', () => {
  const canonical = policyMarked(read(REFERENCE), 'reference');
  for (const name of CONSUMERS) {
    assert.deepEqual(
      policyMarked(read(agent(name)), name),
      canonical,
      `${name} の parts-policy が reference と食い違っている。両方を同時に直すこと`,
    );
  }
});

test('AC8: 正準の1文が記録先・3レベル・未設定時の既定を持つ', () => {
  const line = policyMarked(read(REFERENCE), 'reference').join('');
  for (const w of ['docs/dev-flow/ui-policy.md', 'level:', 'A', 'B', 'C', 'ファイルが無ければ B', '方針未設定']) {
    assert.ok(line.includes(w), `正準に「${w}」がない`);
  }
});

test('AC9: G1〜G4 があり、区分・強度が設計どおり(G1 設 / G2 画 / G3 操 / G4 画。G4 だけ推奨)', () => {
  const byId = Object.fromEntries(items().map((i) => [i.id, i]));
  const want = { G1: ['設', '必須'], G2: ['画', '必須'], G3: ['操', '必須'], G4: ['画', '推奨'] };
  for (const [id, [kind, level]] of Object.entries(want)) {
    assert.ok(byId[id], `${id} がない`);
    assert.equal(byId[id].kind, kind, `${id} の区分`);
    assert.equal(byId[id].level, level, `${id} の強度`);
  }
});

test('AC10: ブラウザ標準ダイアログは level A だけ許容、B・C は NG と表に書かれている', () => {
  const md = read(REFERENCE);
  const rows = Object.fromEntries(
    [...md.matchAll(/^\| ([ABC]) [^|]+\| [^|]+\| [^|]+\| ([^|]+) \|$/gm)].map((m) => [m[1], m[2].trim()]),
  );
  assert.equal(rows.A, '許容');
  assert.ok(rows.B.startsWith('NG'), `B のダイアログ列: ${rows.B}`);
  assert.ok(rows.C.startsWith('NG'), `C のダイアログ列: ${rows.C}`);
});

test('AC11: ui-designer は DESIGN.md の「UI部品方針」節と ui-policy.md を、qa-ux-evaluator は ui-policy.md を読む', () => {
  assert.match(read(agent('ui-designer')), /UI部品方針\*\* — `docs\/dev-flow\/ui-policy\.md`/);
  assert.ok(read(agent('ui-designer')).includes('ファイルは勝手に作らない'));
  assert.match(read(agent('qa-ux-evaluator')), /\*\*UI部品方針\*\*（あれば）: `docs\/dev-flow\/ui-policy\.md`/);
  assert.ok(read(agent('qa-explorer')).includes('browser_handle_dialog'));
});
