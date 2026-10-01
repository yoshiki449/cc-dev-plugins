// 実行: node --test plugins/dev-flow/skills/dev-ship/ship-memory-gate.test.mjs
//
// dev-ship の E4・E6 は ai-memory の MCP、E5 は手元にしか無い ~/.agent/worklog/ に保存する。
// クラウドセッションでも ai-memory plugin が入っていれば memory_store は使えるので、
// E4・E6 を飛ばす条件は「ツールが無いとき」だけにする。クラウドかどうかで飛ばすと、
// 保存できる環境で黙って記憶が残らない。E5 だけがクラウドで飛ぶ。
// 語の存在チェックは否定を1文足すだけで通り抜けるので、マーカー内の文と、その文が置かれている位置を固定する。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL = path.join(path.dirname(fileURLToPath(import.meta.url)), 'SKILL.md');
const md = fs.readFileSync(SKILL, 'utf8');

function gate(name) {
  const re = new RegExp(`<!-- ${name} -->\\n([\\s\\S]*?)\\n<!-- /${name} -->`, 'g');
  const all = [...md.matchAll(re)];
  assert.equal(all.length, 1, `${name} のマーカーはちょうど1組のはず`);
  return { text: all[0][1], index: all[0].index };
}

function pos(heading) {
  const i = md.indexOf(heading);
  assert.ok(i >= 0, `${heading} の見出しが見つからない`);
  return i;
}

test('記憶保存の分岐は E3 の後、E4 の前にある', () => {
  const { index } = gate('ship-memory-gate');
  assert.ok(pos('### E3.') < index && index < pos('### E4.'), '分岐が E4 より前に無いと、E4 を実行してから気づく');
});

test('記憶保存の分岐は memory_store の有無だけで E4〜E6 を飛ばし、E7 で報告させる', () => {
  const text = gate('ship-memory-gate').text;
  assert.match(text, /^`memory_store` ツールが使えないときは、E4〜E6 を実行せずに E7 へ進み、/);
  assert.match(text, /終了メッセージに「E4〜E6（記憶保存・作業日報・記憶整理）は保存先が無い環境なので飛ばした」と書く。/);
  assert.match(text, /ToolSearch で `memory_store` を探してから判断する。$/);
});

test('記憶保存の分岐はクラウドかどうかを条件にしない', () => {
  assert.doesNotMatch(gate('ship-memory-gate').text, /CLAUDE_CODE_REMOTE/);
});

test('作業日報の分岐は E5 の見出しの直後にあり、クラウドでだけ E5 を飛ばす', () => {
  const { text, index } = gate('ship-worklog-gate');
  assert.ok(pos('### E5.') < index && index < pos('### E6.'), '分岐が E5 の中に無い');
  assert.match(text, /^`CLAUDE_CODE_REMOTE` が `true` のときは、この E5 を実行せずに E6 へ進み、/);
  assert.match(text, /終了メッセージに「E5（作業日報）はクラウドに保存先が無いので飛ばした」と書く。$/);
  assert.doesNotMatch(text, /E4|memory_store/, 'E5 の分岐が記憶保存まで飛ばすと、クラウドで記憶が残らない');
});

test('E7 の終了メッセージが飛ばした場合の報告を持つ', () => {
  const e7 = md.slice(pos('### E7.'));
  assert.match(e7.split('\n').slice(0, 3).join('\n'), /飛ばしたものとその理由/);
});
