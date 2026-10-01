// 実行: node --test plugins/dev-flow/hooks/suggest-dev-skill.test.js
//
// Issue を作る依頼の言い回しは「切って／立てて／作成して／起票して」と揺れる。
// dev-plan に当たらないと、依頼の入口で dev-plan を通らずに Issue が作られる。

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'suggest-dev-skill.sh');

function run(prompt) {
  const res = spawnSync('bash', [HOOK], { input: JSON.stringify({ prompt }), encoding: 'utf8' });
  assert.equal(res.status, 0);
  return res.stdout;
}

for (const prompt of [
  'Issue切って',
  'issueを作成してください',
  'この件のIssueを立てて',
  'GitHub に issue を作って',
  'バグを起票して',
]) {
  test(`dev-plan に当たる: ${prompt}`, () => {
    assert.match(run(prompt), /\/dev-plan/);
  });
}

test('Issue に触れない発話では dev-plan を案内しない', () => {
  assert.doesNotMatch(run('ボタンの色を変えて'), /\/dev-plan/);
});
