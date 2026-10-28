// 実行: node --test plugins/dev-flow/skills/dev-setup/setup-agent-source.test.mjs
//
// B1-3 は `.agent/` のコピー元を main clone と決め打ちしていた。worktree を連鎖させる運用では
// 古い main clone から写して、引継書が欠けたまま implement に入る。語の存在チェックは
// 「main clone が正本」への書き戻しでも通るので、マーカー内の1文と、判定器を呼ぶ位置を固定する。
// 規模判定の確認手順（B1-3.6 step 6）も、差分ゼロの worktree では除外パターンの効きを
// 確かめられないので、過去のコミット範囲（--base/--head）を使う指示を固定する。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILLS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const setup = fs.readFileSync(path.join(SKILLS, 'dev-setup', 'SKILL.md'), 'utf8');

const section = (from, to) => {
  const a = setup.indexOf(from);
  const b = setup.indexOf(to);
  assert.ok(a >= 0 && b > a, `${from} 〜 ${to} が見つからない`);
  return setup.slice(a, b);
};

test('正準の1文: コピー元は最終更新の新しいものを pick-agent-source.sh で選ぶ', () => {
  const all = [...setup.matchAll(/<!-- agent-source-by-recency -->\n([\s\S]*?)\n<!-- \/agent-source-by-recency -->/g)];
  assert.equal(all.length, 1);
  const lines = all[0][1].split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /main clone と既存の worktree のうち `pick-agent-source\.sh` が最終更新の新しいと判定したもの/);
});

test('マーカーは B1-3 の節内にあり、判定器の実行は cp の前にある', () => {
  const b13 = section('#### B1-3.', '#### B1-3.5.');
  assert.ok(b13.includes('<!-- agent-source-by-recency -->'));
  const pick = b13.indexOf('bash skills/_shared/scripts/pick-agent-source.sh');
  const cp = b13.indexOf('cp -a .agent/.');
  assert.ok(pick >= 0 && cp > pick);
});

test('B1-3 の見出しと手順は main clone を正本と決め打ちしていない', () => {
  const b13 = section('#### B1-3.', '#### B1-3.5.');
  assert.doesNotMatch(b13.split('\n')[0], /main clone から/);
  assert.doesNotMatch(b13, /cd <project-folder>\/repo\n/);
  assert.match(b13, /根拠.*完了報告に書く/);
});

test('B6-0 は main clone を正本としない', () => {
  assert.doesNotMatch(setup, /`repo\/\.agent` は B1-3 でコピーした別実体/);
  assert.match(setup, /main clone が常に正本とは限らない/);
});

test('size-tier の確認手順は過去のコミット範囲で判定器を走らせる', () => {
  const step6 = section('6. **判定器を過去のコミット範囲', '<!-- このフェンスの info string');
  assert.match(step6, /assess-change-size\.sh --dir <worktreeの絶対パス> --base HEAD~20 --head HEAD/);
  assert.match(step6, /未コミットの変更[\s\S]*見ない/);
  assert.match(step6, /`excluded_paths` が空ならパターンが当たっていない/);
});
