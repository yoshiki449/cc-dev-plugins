// 実行: node --test plugins/dev-flow/skills/dev-setup/setup-cloud-no-worktree.test.mjs
//
// クラウドでは worktree を作らない。この分岐が消えると dev-setup がクラウドの clone を
// repo/ + worktrees/ に組み替えようとする。反転（「作る」への書き換え）は語の存在チェックでは
// 検知できないので、マーカー内の1文と位置を固定する。あわせて、ensure-worktree.sh が返す
// status を dev-implement / dev-fix の表が全部持っているかを見る（持っていないと実装で止まる）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILLS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(SKILLS, ...p), 'utf8');
const setup = read('dev-setup', 'SKILL.md');

function gate() {
  const all = [...setup.matchAll(/<!-- setup-cloud-no-worktree -->\n([\s\S]*?)\n<!-- \/setup-cloud-no-worktree -->/g)];
  assert.equal(all.length, 1, 'setup-cloud-no-worktree のマーカーはちょうど1組のはず');
  return { text: all[0][1], index: all[0].index };
}

test('分岐は B1 の見出しの後、worktree の作成・移行（B1-1）の前にある', () => {
  const { index } = gate();
  const b1 = setup.indexOf('### B1.');
  const b11 = setup.indexOf('#### B1-1.');
  assert.ok(b1 >= 0 && b11 >= 0, 'B1 / B1-1 の見出しが見つからない');
  assert.ok(b1 < index && index < b11);
});

test('正準の1文: クラウドでは worktree を作らず B1-1〜B1-3 と B6-0 を実行しない', () => {
  const lines = gate().text.split('\n').filter(Boolean);
  assert.equal(lines.length, 1, '正準は1文のはず（打ち消しの文を足す変更を検知する）');
  assert.match(lines[0], /^`CLAUDE_CODE_REMOTE` が `true` のときは worktree を作らず、/);
  assert.match(lines[0], /B1-1〜B1-3 と B6-0 を実行しない。$/);
});

test('B1-1〜B1-3 と B6-0 はクラウドで飛ばす対象として実在する', () => {
  for (const h of ['#### B1-1.', '#### B1-2.', '#### B1-3.', '0. **B1-1 で移行した場合のみ**']) {
    assert.ok(setup.includes(h), `${h} が無い（正準の1文の参照先が消えている）`);
  }
});

const script = fs.readFileSync(path.join(SKILLS, '_shared', 'scripts', 'ensure-worktree.sh'), 'utf8');
const statuses = [...new Set([...script.matchAll(/emit "([a-z_]+)"/g)].map((m) => m[1]))];

for (const [skill, step] of [['dev-implement', 'Step 1'], ['dev-fix', 'F1']]) {
  const md = read(skill, 'SKILL.md');
  test(`${skill}: ensure-worktree.sh の status を表が全部持つ`, () => {
    assert.ok(statuses.includes('cloud_clone'), 'ensure-worktree.sh が cloud_clone を返さない');
    for (const s of statuses) {
      if (s === 'not_a_repo') continue; // 表では「not_a_repo」と書く
      assert.ok(md.includes(`\`${s}\``), `${skill} の表に ${s} が無い`);
    }
    assert.ok(md.includes('`not_a_repo`'));
  });
  test(`${skill}: cloud_clone は中断せず ${step} に進む`, () => {
    const row = md.split('\n').find((l) => l.startsWith('| `cloud_clone`'));
    assert.ok(row, 'cloud_clone の行が無い');
    assert.match(row, new RegExp(`そのまま ${step} に進む`));
    assert.doesNotMatch(row, /中断/);
  });
}
