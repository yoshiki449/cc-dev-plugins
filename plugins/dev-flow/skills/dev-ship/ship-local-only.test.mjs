// 実行: node --test plugins/dev-flow/skills/dev-ship/ship-local-only.test.mjs
//
// dev-ship の E4〜E6 は手元にしか無い保存先を使う。クラウドセッションで飛ばす分岐が消えたり
// 反転したりすると、ship の最後でツールを探して止まる。語の存在チェックは否定を1文足すだけで
// 通り抜けるので、マーカー内の文と、その文が置かれている位置を固定する。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL = path.join(path.dirname(fileURLToPath(import.meta.url)), 'SKILL.md');
const md = fs.readFileSync(SKILL, 'utf8');

function gate() {
  const all = [...md.matchAll(/<!-- ship-local-only -->\n([\s\S]*?)\n<!-- \/ship-local-only -->/g)];
  assert.equal(all.length, 1, 'ship-local-only のマーカーはちょうど1組のはず');
  return { text: all[0][1], index: all[0].index };
}

test('分岐は E3 の後、E4 の前にある', () => {
  const { index } = gate();
  const e3 = md.indexOf('### E3.');
  const e4 = md.indexOf('### E4.');
  assert.ok(e3 >= 0 && e4 >= 0, 'E3 / E4 の見出しが見つからない');
  assert.ok(e3 < index && index < e4, '分岐が E4 より前に無いと、E4 を実行してから気づく');
});

test('分岐はクラウドとツール不在の両方で E4〜E6 を飛ばし、E7 で報告させる', () => {
  const lines = gate().text.split('\n').filter(Boolean);
  assert.equal(lines.length, 1, '正準は1文のはず（打ち消しの文を足す変更を検知する）');
  assert.match(lines[0], /^`CLAUDE_CODE_REMOTE` が `true` のとき、または `memory_store` ツールが使えないときは、/);
  assert.match(lines[0], /E4〜E6 を実行せずに E7 へ進み、/);
  assert.match(lines[0], /終了メッセージに「E4〜E6（記憶保存・作業日報・記憶整理）は保存先が無い環境なので飛ばした」と書く。$/);
});

test('E7 の終了メッセージが飛ばした場合の報告を持つ', () => {
  const e7 = md.slice(md.indexOf('### E7.'));
  assert.match(e7.split('\n').slice(0, 3).join('\n'), /E4〜E6 を飛ばしたときは、飛ばしたこととその理由/);
});
