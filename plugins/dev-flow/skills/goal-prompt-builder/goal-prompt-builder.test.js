#!/usr/bin/env node
'use strict';

// goal-prompt-builder の条件文に入れる2文のドリフト検出。
// 実行: node --test plugins/dev-flow/skills/goal-prompt-builder/goal-prompt-builder.test.js
//
// 正準は SKILL.md の手順5・6のマーカー内の1文で、同じ SKILL.md の「例」に複製で置いている。
// 語の存在チェックは指示を反転しても通るので、マーカーから読んで例と byte-identical で比較する。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SKILLS = path.join(__dirname, '..');
const md = fs.readFileSync(path.join(__dirname, 'SKILL.md'), 'utf8');

function marked(name) {
  const m = md.match(new RegExp(`<!-- ${name} -->\\n([\\s\\S]*?)\\n<!-- /${name} -->`));
  assert.ok(m, `${name} のマーカーが見つからない`);
  return m[1].trim();
}

const example = md.slice(md.indexOf('## 例'));

test('AC1: 進め方の正準は dev-implement → dev-verify → dev-qa → dev-ship の順で、PR 作成を dev-qa の後に置く', () => {
  const s = marked('goal-phase-order');
  const order = ['dev-implement', 'dev-verify', 'dev-qa', 'dev-ship'].map((k) => s.indexOf(k));
  assert.ok(order.every((i) => i >= 0), '4スキルがすべて入っていない');
  assert.deepEqual([...order].sort((a, b) => a - b), order, '順序が崩れている');
  assert.match(s, /dev-ship）は dev-qa の後/);
});

test('AC2: 進め方に書いたスキルが実在する', () => {
  for (const k of ['dev-implement', 'dev-verify', 'dev-qa', 'dev-ship']) {
    assert.ok(fs.existsSync(path.join(SKILLS, k, 'SKILL.md')), `${k} が無い`);
  }
});

test('AC3: 例の条件文が進め方の正準1文を byte-identical で含む', () => {
  assert.ok(example.includes(marked('goal-phase-order')), '例の進め方が正準と食い違っている');
});

test('AC4: 例の条件文が例外時の案内の正準1文を byte-identical で含む', () => {
  const s = marked('goal-exception-notice');
  assert.match(s, /1回だけ案内して、そのターンで止まる/);
  assert.ok(example.includes(s), '例の例外案内が正準と食い違っている');
});

test('AC5: 実行できない完了条件を条件文に入れない指示がある', () => {
  assert.match(md, /この実行環境で実行できない完了条件は、条件文に入れない/);
});
