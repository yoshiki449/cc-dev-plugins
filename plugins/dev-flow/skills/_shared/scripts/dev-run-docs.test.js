#!/usr/bin/env node
'use strict';

// /dev-run が内側のループとして dev-loop を呼ぶ契約（boundary=none）の文書テスト。
// 実行: node --test plugins/dev-flow/skills/_shared/scripts/dev-run-docs.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SKILLS = path.join(__dirname, '..', '..');
const read = (n) => fs.readFileSync(path.join(SKILLS, n, 'SKILL.md'), 'utf8');
const RUN = read('dev-run');
const LOOP = read('dev-loop');

test('dev-run は implement〜verify を dev-loop boundary=none に任せると書いている', () => {
  assert.match(RUN, /`\/dev-loop boundary=none`/);
});

test('dev-loop は引数 boundary=none と、その節の分岐 4 行を持つ', () => {
  assert.match(LOOP, /\/dev-loop boundary=none /);
  const sec = LOOP.match(/#### L1\.5d `boundary=none` のとき\n([\s\S]*?)\n### L2\./);
  assert.ok(sec, 'boundary=none の節が無い');
  for (const k of ['halted-checkpoint', '`done=false`', '`confidence ≥ 80`', '`confidence < 80`']) {
    assert.ok(sec[1].includes(k), `分岐に ${k} が無い`);
  }
  assert.doesNotMatch(sec[1], /AskUserQuestion で/);
});

test('dev-run は qa 不合格の修正ループ上限（3 周・コミット 15・90 分）を持つ', () => {
  assert.match(RUN, /3 周まで/);
  assert.match(RUN, /15 件/);
  assert.match(RUN, /90 分/);
});

test('boundary=none でも dev-loop の既定の境界確認（L1.5d）は残っている', () => {
  assert.match(LOOP, /#### L1\.5d 境界確認 AskUserQuestion/);
  assert.match(LOOP, /\| 完了（推奨） \|/);
});
