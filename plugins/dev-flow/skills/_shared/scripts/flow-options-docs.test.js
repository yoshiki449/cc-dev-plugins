#!/usr/bin/env node
'use strict';

// 要否設定の消費者（flow-options.md の表）と、各 SKILL.md の複製ブロックを突き合わせる。
// 実行: node --test plugins/dev-flow/skills/_shared/scripts/flow-options-docs.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SKILLS = path.join(__dirname, '..', '..');
const REF = fs.readFileSync(path.join(SKILLS, '_shared/reference/flow-options.md'), 'utf8');
const MARK = /<!-- flow-options -->\n([\s\S]*?)<!-- \/flow-options -->/;
const CANON = REF.match(MARK)[1];

// 消費者表の行: | `skill` | `key`, `key` |
const consumers = [...REF.matchAll(/^\| `([a-z-]+)` \| ((?:`[a-z_]+`(?:, )?)+) \|$/gm)].map((m) => ({
  skill: m[1],
  keys: m[2].match(/[a-z_]+/g),
}));

test('消費者表に 5 スキルが載っている', () => {
  assert.deepEqual(consumers.map((c) => c.skill).sort(), ['dev', 'dev-implement', 'dev-qa', 'dev-ship', 'dev-verify']);
});

for (const { skill, keys } of consumers) {
  const text = fs.readFileSync(path.join(SKILLS, skill, 'SKILL.md'), 'utf8');
  if (skill === 'dev') {
    test('dev ルーターは test_spec の on / off を判定に書いている', () => {
      assert.match(text, /flow-options\.sh[^\n]*`test_spec`[^\n]*`on`[^\n]*`off`/);
    });
    continue;
  }
  test(`${skill}: 正準の文が複製されている`, () => {
    const m = text.match(MARK);
    assert.ok(m, 'マーカーが無い');
    assert.equal(m[1], CANON);
  });
  test(`${skill}: 使うキーごとに on / off の扱いが本文にある`, () => {
    for (const key of keys) {
      assert.match(text, new RegExp('`' + key + '` が `(on|off)`'), `${key} の扱いが無い`);
    }
  });
}

test('/dev-config スキルが存在し、判定器と設定ファイルを参照している', () => {
  const t = fs.readFileSync(path.join(SKILLS, 'dev-config/SKILL.md'), 'utf8');
  assert.match(t, /^name: dev-config$/m);
  assert.match(t, /flow-options\.sh/);
  assert.match(t, /docs\/dev-flow\/flow-options\.conf/);
});
