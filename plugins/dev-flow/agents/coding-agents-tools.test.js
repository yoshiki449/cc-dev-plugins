#!/usr/bin/env node
'use strict';

// 実装系 agent の frontmatter `tools:` が、再委任できない allowlist になっていることを固定する（Issue #77）。
// 実行: node --test plugins/dev-flow/agents/coding-agents-tools.test.js
//
// なぜ必要か:
//   japanese-coding-specialist は `tools:` が無く全ツールを使えた。Agent / Task で別インスタンスへ
//   再委任し、互換性のない実装が同じディレクトリに併存した。本文で「再委任するな」と明示しても
//   止まらなかったので、プロンプトではなく tools で塞ぐ。
//
// 落ちたときの直し方:
//   `tools:` を実装に必要なツールの列挙に戻す。Agent / Task を足さない。
//   tools の行を消すと「全ツール」になり、このテストが落ちる（意図通り）。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// 実装を自分の手で行う agent。allowlist にしているのは、足し忘れた agent が黙って素通りしないため。
const CODING_AGENTS = ['japanese-coding-specialist', 'implementer', 'tdd-implementer', 'test-writer', 'Debugger'];
const FORBIDDEN = ['Agent', 'Task'];
const REQUIRED = ['Read', 'Bash', 'Grep', 'Glob'];

const toolsOf = (name) => {
  const md = fs.readFileSync(path.join(__dirname, `${name}.md`), 'utf8');
  const fm = md.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(fm, `${name}: frontmatter が無い`);
  const line = fm[1].split('\n').find((l) => /^tools:/.test(l));
  assert.ok(line, `${name}: tools: が無い（省略すると全ツール＝Agent / Task も使える）`);
  return line.replace(/^tools:/, '').split(',').map((t) => t.trim()).filter(Boolean);
};

for (const name of CODING_AGENTS) {
  test(`${name}: tools に Agent / Task を含まない`, () => {
    const tools = toolsOf(name);
    for (const f of FORBIDDEN) assert.ok(!tools.includes(f), `${name} が ${f} を持っている: ${tools}`);
  });
  test(`${name}: 実装に必要なツールを持つ`, () => {
    const tools = toolsOf(name);
    for (const r of REQUIRED) assert.ok(tools.includes(r), `${name} に ${r} が無い: ${tools}`);
    assert.ok(tools.includes('Write') || tools.includes('Edit'), `${name} に Write / Edit が無い`);
  });
}

test('japanese-coding-specialist: 本文に再委任しない旨がある', () => {
  const md = fs.readFileSync(path.join(__dirname, 'japanese-coding-specialist.md'), 'utf8');
  assert.ok(md.includes('別のエージェントへ再委任しない'));
});
