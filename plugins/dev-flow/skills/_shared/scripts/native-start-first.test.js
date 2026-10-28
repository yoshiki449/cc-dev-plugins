#!/usr/bin/env node
'use strict';

// dev-qa Q2 の「docker が無いと感じたら直接起動を試す」手順のドリフト検出。
// 実行: node --test plugins/dev-flow/skills/_shared/scripts/native-start-first.test.js
//
// 実測の動機: クラウドのセッションで「docker が無いので環境を起動できない」と判断して
// QA を約50分保留した。docker を使わずにバックエンドとフロントエンドを直接起動すれば
// Playwright MCP で QA できた。語の存在チェックは否定を足すだけで通るので、
// マーカー内の順序と、レポートへの記録先（Q5）までを固定する。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const QA = path.join(__dirname, '..', '..', 'dev-qa', 'SKILL.md');
const md = fs.readFileSync(QA, 'utf8');

function block() {
  const m = md.match(/<!-- native-start-first -->\n([\s\S]*?)\n[ \t]*<!-- \/native-start-first -->/);
  assert.ok(m, 'native-start-first のマーカーが見つからない');
  return m[1];
}

test('AC1: 保留で終えず、直接起動 → cloud-stack → 未実施記録の順に試させる', () => {
  const b = block();
  const i1 = b.indexOf('(1)');
  const i2 = b.indexOf('(2)');
  const i3 = b.indexOf('(3)');
  assert.ok(i1 >= 0 && i1 < i2 && i2 < i3, '手順 (1)(2)(3) がこの順に無い');
  assert.ok(b.includes('CLAUDE.md') && b.includes('README'), '直接起動の探し先が無い');
  assert.ok(b.includes('.claude/cloud-stack.json'), 'cloud-stack の入口が無い');
  assert.ok(/どちらも失敗したときだけ/.test(b), '未実施にしてよい条件が無い');
  assert.ok(/保留・未実施にしない/.test(b), '先に止めない指示が無い');
});

test('AC2: 試した結果の記録先が Q5 のレポート雛形にある', () => {
  assert.ok(block().includes('環境起動の試行'));
  const q5 = md.split('### Q5. QAレポートの作成')[1].split('### Q5.5')[0];
  assert.ok(q5.includes('## 環境起動の試行'), 'レポート雛形に節が無い');
});

test('AC3: マーカーは Q2 環境確認の中にある', () => {
  const q2 = md.split('### Q2. 環境確認')[1].split('### Q3.')[0];
  assert.ok(q2.includes('<!-- native-start-first -->'));
});
