const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');
const marked = (text, name) => {
  const m = text.match(new RegExp(`<!-- ${name} -->\\n([\\s\\S]*?)\\n<!-- /${name} -->`));
  return m && m[1];
};

test('UI 観察の正準の文が explorer と poc-smoke で一致する', () => {
  const explorer = marked(read('agents/poc-smoke-explorer.md'), 'poc-flow:ui-observe');
  const smoke = marked(read('skills/poc-smoke/SKILL.md'), 'poc-flow:ui-observe');
  assert.ok(explorer, 'explorer にマーカーがある');
  assert.strictEqual(smoke, explorer);
  assert.match(explorer, /OK\/NG の判定はしない/);
  assert.match(explorer, /20操作の上限に数える/);
});

test('poc-ship は UI 未評価と自動で決めた前提を PR 本文に載せ、poc-build は前提を記録する', () => {
  const ship = read('skills/poc-ship/SKILL.md');
  assert.match(ship, /## 自動で決めた前提/);
  assert.match(ship, /UI\/UX の評価.*未実施/);
  assert.match(read('skills/poc-build/SKILL.md'), /「自動で決めた前提」表に1行ずつ書く/);
});

test('GOAL.md の雛形に UI部品方針があり、既定は A で C は扱わない', () => {
  const poc = read('skills/poc/SKILL.md');
  assert.match(poc, /## UI部品方針\n- A（/);
  assert.match(poc, /UI部品方針は A を既定にし、聞かない/);
  assert.match(poc, /C は PoC では扱わない/);
});
