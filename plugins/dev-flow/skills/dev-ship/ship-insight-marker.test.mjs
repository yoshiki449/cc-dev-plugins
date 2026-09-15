// 実行: node --test plugins/dev-flow/skills/dev-ship/ship-insight-marker.test.mjs
//
// E3.5 はクラウドで消える知見を PR 本文に書き出す唯一の経路。fail-closed の条件が
// 緩んで PUBLIC リポジトリにも書かれるようになると、public plugin の PR に固有名詞や
// 内部事情が漏れる（publish-scan.sh は PR 本文を見ないので検出できない）。
// 語の存在チェックは否定を1文足すだけで通り抜けるので、ship-local-only.test.mjs と
// 同じ流儀でマーカーの文言と位置を固定する。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL = path.join(path.dirname(fileURLToPath(import.meta.url)), 'SKILL.md');
const md = fs.readFileSync(SKILL, 'utf8');

function gate() {
  const all = [...md.matchAll(/<!-- ship-insight-marker -->\n([\s\S]*?)\n<!-- \/ship-insight-marker -->/g)];
  assert.equal(all.length, 1, 'ship-insight-marker のマーカーはちょうど1組のはず');
  return { text: all[0][1], index: all[0].index };
}

test('分岐は ship-local-only の後、E4 の前にある', () => {
  const { index } = gate();
  const shipLocalOnlyEnd = md.indexOf('<!-- /ship-local-only -->');
  const e4 = md.indexOf('### E4.');
  assert.ok(shipLocalOnlyEnd >= 0 && e4 >= 0, 'ship-local-only の終端 / E4 の見出しが見つからない');
  assert.ok(shipLocalOnlyEnd < index && index < e4, 'E3.5 は ship-local-only の後・E4 の前に無いと、E4 実行後に気づく');
});

test('書き込み条件は PRIVATE 厳密一致で fail closed', () => {
  const lines = gate().text.split('\n').filter(Boolean);
  assert.equal(lines.length, 1, '正準は1文のはず（緩める変更を検知する）');
  assert.match(lines[0], /^`CLAUDE_CODE_REMOTE` が `true` のとき、または `memory_store` ツールが使えないとき、かつ `gh repo view --json visibility -q \.visibility` が厳密に `PRIVATE` のときだけ、/);
  assert.match(lines[0], /それ以外（判定不能を含む）は書かない。$/);
});

test('E3.5 の手順が fail-closed の明示と session-insight マーカー形式を含む', () => {
  const e35Start = md.indexOf('### E3.5.');
  const e4 = md.indexOf('### E4.');
  assert.ok(e35Start >= 0 && e4 >= 0, 'E3.5 / E4 の見出しが見つからない');
  const body = md.slice(e35Start, e4);
  assert.match(body, /\*\*fail closed\*\*/, 'fail-closed の明示が本文から消えている');
  assert.match(body, /<!-- session-insight v1 -->/);
  assert.match(body, /<!-- \/session-insight -->/);
});
