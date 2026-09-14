#!/usr/bin/env node
'use strict';

// サブエージェント成果物の受け渡し契約（Issue #53 / #56）のドリフト検出。
// 実行: node --test plugins/dev-flow/skills/_shared/scripts/subagent-output-contract.test.js
//
// 起動プロンプトの4項目と、呼び出し側の確認2行は _shared/reference/subagent-output-contract.md
// が正準だが、**agent 起動時にプロンプト文字列へ埋め込む必要があり、実行時に他ファイルを
// 読めない**ため消費側の SKILL.md にも複製で置いている（#45 の core-flow.md と同じ配り方）。
//
// 落ちる方向が悪い: 正準側だけ強化して消費側が古いままだと、実際に agent へ渡るのは
// 古い方なので**改善が一切効かないまま「直した」ことになる**。
//
// **語の存在チェック（includes / 部分マッチ）は使わない。** 以前 AC5/AC6 を
// `.includes('再起動するときはプロンプトを差し替える')` で書いていたが、その直後に
// 「必要はない。同じプロンプトのまま再起動する」と足すだけで 9/9 PASS のまま
// 指示が反転した（2026-09-01 codex が実測）。部分一致では極性を守れないので、
// マーカーで囲んだ行を byte-identical で比較する。
//
// 消費者リストはこのファイルに持たず _shared/README.md の表から読む。テスト側に配列を
// 置くと、消費者を足したときテストと README の2箇所を直す必要が生まれ README だけ古くなる。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { section } = require('./md-section.js');

const SKILLS = path.join(__dirname, '..', '..');
const CONTRACT = path.join(SKILLS, '_shared', 'reference', 'subagent-output-contract.md');
const README = path.join(SKILLS, '_shared', 'README.md');
const CONSUMER_SECTION = '## サブエージェント成果物の受け渡し契約の消費者';

// 型ごとの期待件数。件数だけでなく**型の内訳**まで固定する。合計だけを見ていると、
// ある行を別の型の行に差し替えても合計は変わらず、その型の検査が空ループで素通りする
// （2026-09-01 に Code-Reviewer と codex が独立に実測）。
const EXPECTED = { 'file-output': 3, 'body-return': 1 };

const read = (p) => fs.readFileSync(p, 'utf8');
const skillMd = (name) => path.join(SKILLS, name, 'SKILL.md');

/** マーカーで囲まれた行を取り出す。行頭のインデントは落とす（消費側はネストされる）。 */
function marked(md, kind, where) {
  const re = new RegExp(
    `<!-- subagent-output-contract:${kind} -->\\n([\\s\\S]*?)\\n[ \\t]*<!-- /subagent-output-contract:${kind} -->`
  );
  const m = md.match(re);
  assert.ok(m, `${where}: ${kind} のマーカーが見つからない（片方だけ消していないか）`);
  return m[1].split('\n').map((l) => l.replace(/^\s+/, '')).filter(Boolean);
}

/** README の表から消費者を読む。テスト側に配列を持たない（正は README）。 */
function consumers() {
  const body = section(read(README), CONSUMER_SECTION);
  return body
    .split('\n')
    .map((l) => l.match(/^\|\s*`([^`]+)`\s*\|\s*(file-output|body-return)\s*\|\s*`([^`]+)`\s*\|/))
    .filter(Boolean)
    .map((m) => ({ skill: m[1], kind: m[2], section: m[3] }));
}

test('AC1: 消費者表が4件・重複なし・型の内訳どおりである', () => {
  const list = consumers();
  assert.equal(list.length, 4, `消費者は4件のはず: ${JSON.stringify(list.map((c) => c.skill))}`);

  // 一意性。合計だけのガードだと、1行を別行の複製に差し替えても通ってしまい、
  // 差し替えられたスキルが全検査から静かに消える（実測済み）。
  const names = list.map((c) => c.skill);
  assert.equal(new Set(names).size, names.length, `消費者に重複がある: ${names.join(', ')}`);

  // 型の内訳。片方の型が0件になると、その型を対象にした検査が空ループで素通りする。
  for (const [kind, n] of Object.entries(EXPECTED)) {
    assert.equal(
      list.filter((c) => c.kind === kind).length,
      n,
      `${kind} の消費者は ${n} 件のはず`
    );
  }
});

test('AC2: 起動プロンプト4項目が、全消費者で正準と一致する', () => {
  const contract = read(CONTRACT);
  const canonical = {
    'file-output': marked(contract, 'file-output', 'contract'),
    'body-return': marked(contract, 'body-return', 'contract'),
  };
  for (const c of consumers()) {
    const body = section(read(skillMd(c.skill)), c.section);
    assert.deepEqual(
      marked(body, c.kind, `${c.skill} / ${c.section}`),
      canonical[c.kind],
      `${c.skill} の ${c.kind} 4項目が contract と食い違っている。両方を同時に直すこと`
    );
  }
});

test('AC3: 呼び出し側の確認2行が、全消費者で正準と一致する', () => {
  // 以前は includes() でアンカーを探していたが、直後に否定を足すだけで通り抜けられた。
  // 行そのものを byte-identical で固定する。
  const contract = read(CONTRACT);
  const canonical = {
    'file-output': marked(contract, 'file-output-checks', 'contract'),
    'body-return': marked(contract, 'body-return-checks', 'contract'),
  };
  for (const [kind, lines] of Object.entries(canonical)) {
    assert.equal(lines.length, 2, `${kind}-checks は2行のはず`);
  }
  for (const c of consumers()) {
    const md = read(skillMd(c.skill));
    assert.deepEqual(
      marked(md, `${c.kind}-checks`, c.skill),
      canonical[c.kind],
      `${c.skill} の確認2行が contract と食い違っている`
    );
  }
});

test('AC4: 両型とも1番目が回数を数値で渡し、上限より小さい値を求めている', () => {
  const contract = read(CONTRACT);
  for (const kind of ['file-output', 'body-return']) {
    const first = marked(contract, kind, 'contract')[0];
    assert.match(first, /ツール呼び出しは \*\*N 回まで\*\*/, `${kind}: 回数の数値指定が要る`);
    // N の決め方まで固定する。ハーネス上限と同値だと書く余地が残らない
    // （N=20 を渡したエージェントが20回使い切って未出力のまま停止した実測がある）。
    assert.match(first, /ハーネスのターン上限より小さい値にする/, `${kind}: 上限より小さい指定が消えている`);
  }
});

test('AC5: 型ごとに成果物の渡し方が違うことが項目に現れている', () => {
  // 型を取り違えて body-return の消費者に「Write せよ」と書く事故を検知する。
  // slice() の接頭辞比較は使わない（意味を反転しても接頭辞が残れば通ってしまう）。
  const contract = read(CONTRACT);
  const file = marked(contract, 'file-output', 'contract');
  const body = marked(contract, 'body-return', 'contract');

  assert.match(file[1], /必ず最後に Write ツールで指定パスへ出力する/);
  assert.match(file[2], /Write が完了してから最終応答を返す/);
  assert.match(body[1], /必ず所見を最終メッセージ本文で全文返す/);
  assert.match(body[2], /完了通知だけで終えるのは失敗とみなす/);
  assert.ok(!body.join('\n').includes('Write ツール'), 'body-return に Write の指示を混ぜない');
  assert.equal(file[0], body[0], '1番目（回数上限）は両型で同じ');
  assert.match(file[3], /指摘が0件なら「0件」と明記した/);
  assert.match(body[3], /指摘が0件なら「0件」と明記して返す/);
});

test('AC6: 契約の「上限停止も completed で届く」と再起動の節が生きている', () => {
  assert.match(
    section(read(CONTRACT), '### 1. 存在確認（スキップ不可）'),
    /「上限に達して停止した」という通知も `completed` として届く/
  );
  assert.match(
    section(read(CONTRACT), '### 2. 欠けていたら、同じプロンプトで再起動しない'),
    /先頭に置く/
  );
});

test('AC7: 全消費者から contract への参照が生きている', () => {
  for (const c of consumers()) {
    const md = read(skillMd(c.skill));
    const m = md.match(/\]\((\.\.\/_shared\/reference\/subagent-output-contract\.md)\)/);
    assert.ok(m, `${c.skill}: contract へのリンクが SKILL.md に無い`);
    assert.ok(fs.existsSync(path.join(SKILLS, c.skill, m[1])), `${c.skill}: リンク先が存在しない`);
  }
});
