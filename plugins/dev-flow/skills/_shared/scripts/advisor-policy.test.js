#!/usr/bin/env node
'use strict';

// advisor の扱いとコンテキストの区切り（_shared/reference/advisor-policy.md）のドリフト検出。
// 実行: node --test plugins/dev-flow/skills/_shared/scripts/advisor-policy.test.js
//
// 実際に読まれるのはエージェント定義と SKILL.md の複製なので、正準だけ直すと効かない。
// 語の存在チェックは否定を1文足すだけで通り抜けるので、マーカー内の行を byte-identical で比較する。
// 消費者は _shared/README.md の表から読み、テスト側に配列を持たない。
// エージェント表は allowlist として `agents/` の実ファイルと集合で突き合わせる。
// 新しいエージェントが分類されないまま増えると、advisor の扱いが黙って「制限なし」になるため。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { section } = require('./md-section.js');

const SKILLS = path.join(__dirname, '..', '..');
const AGENTS = path.join(SKILLS, '..', 'agents');
const REFERENCE = path.join(SKILLS, '_shared', 'reference', 'advisor-policy.md');
const README = path.join(SKILLS, '_shared', 'README.md');
const CONSUMER_SECTION = '## advisor の扱いの消費者';
const AGENT_SECTION = '## advisor の扱い\n';

// 内訳まで固定する。合計だけだと、ある行の分類を書き換えても通り、その分類の検査が空ループになる。
const EXPECTED = { reviewer: 19, implementer: 6, none: 5 };

const read = (p) => fs.readFileSync(p, 'utf8');
const skillMd = (name) => path.join(SKILLS, name, 'SKILL.md');

function marked(md, kind, where) {
  const re = new RegExp(`<!-- advisor-policy:${kind} -->\\n([\\s\\S]*?)\\n[ \\t]*<!-- /advisor-policy:${kind} -->`);
  const m = md.match(re);
  assert.ok(m, `${where}: advisor-policy:${kind} のマーカーが見つからない`);
  return m[1].split('\n').map((l) => l.replace(/^\s+/, '')).filter(Boolean);
}

function agentTable() {
  return section(read(README), CONSUMER_SECTION)
    .split('\n')
    .map((l) => l.match(/^\|\s*`([^`]+)`\s*\|\s*(reviewer|implementer|none)\s*\|\s*$/))
    .filter(Boolean)
    .map((m) => ({ agent: m[1], kind: m[2] }));
}

function skillTable() {
  return section(read(README), CONSUMER_SECTION)
    .split('\n')
    .map((l) => l.match(/^\|\s*`([^`]+)`\s*\|\s*(reviewer|context-check)\s*\|\s*「([^」]+)」\s*\|\s*$/))
    .filter(Boolean)
    .map((m) => ({ skill: m[1], kind: m[2], section: m[3] }));
}

test('AC1: エージェント表が agents/ の全ファイルを1回ずつ持ち、分類の内訳どおりである', () => {
  const table = agentTable();
  const names = table.map((r) => r.agent);
  assert.equal(new Set(names).size, names.length, `表に重複がある: ${names.join(', ')}`);

  const files = fs
    .readdirSync(AGENTS)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.slice(0, -3));
  assert.deepEqual([...names].sort(), [...files].sort(), '表と agents/*.md の集合が一致しない（分類し忘れ・消し忘れ）');

  for (const [kind, n] of Object.entries(EXPECTED)) {
    assert.equal(table.filter((r) => r.kind === kind).length, n, `${kind} は ${n} 件のはず`);
  }
});

test('AC2: reviewer / implementer のエージェントは末尾の節に正準の文を byte-identical で持つ', () => {
  const ref = read(REFERENCE);
  const canonical = { reviewer: marked(ref, 'reviewer', 'reference'), implementer: marked(ref, 'implementer', 'reference') };
  for (const { agent, kind } of agentTable()) {
    const md = read(path.join(AGENTS, `${agent}.md`));
    if (kind === 'none') {
      // 制限なしに文が紛れ込むと、設計判断を担うエージェントから advisor を奪う
      assert.ok(!md.includes('<!-- advisor-policy:'), `${agent}: 制限なしなのにマーカーがある`);
      continue;
    }
    assert.ok(md.includes(AGENT_SECTION), `${agent}: 「## advisor の扱い」節が無い`);
    const body = section(md, AGENT_SECTION.trimEnd());
    assert.deepEqual(marked(body, kind, agent), canonical[kind], `${agent} の文が reference と食い違っている`);
    // 片方の分類のマーカーを両方置くと、指示が矛盾する
    const other = kind === 'reviewer' ? 'implementer' : 'reviewer';
    assert.ok(!md.includes(`<!-- advisor-policy:${other} -->`), `${agent}: ${other} のマーカーも持っている`);
  }
});

test('AC3: 正準の極性が保たれている', () => {
  // AC2 は全ファイル同時の反転を通すので、正準側の意味をここで固定する。
  const ref = read(REFERENCE);
  const reviewer = marked(ref, 'reviewer', 'reference');
  assert.equal(reviewer.length, 1, 'reviewer は1行のはず（打ち消しの行を足す変更を検知する）');
  assert.match(reviewer[0], /^- advisor ツールは呼ばない。/);

  const implementer = marked(ref, 'implementer', 'reference');
  assert.equal(implementer.length, 1, 'implementer は1行のはず');
  assert.match(implementer[0], /^- advisor ツールは、同じエラーが2回続いて原因を特定できないときだけ呼ぶ。/);
  assert.match(implementer[0], /着手前・完了前の確認のためには呼ばない$/);

  const check = marked(ref, 'context-check', 'reference');
  assert.equal(check.length, 1, 'context-check は1行のはず');
  assert.match(check[0], /`node skills\/_shared\/scripts\/context-size\.mjs`/);
  assert.match(check[0], /`over` が `true` なら、次に進むかを尋ねる代わりに/);
  assert.match(check[0], /`\/clear` してから次のコマンドを打ってください/);
});

test('AC4: スキルの複製が正準と byte-identical で、reference へのリンクが生きている', () => {
  const ref = read(REFERENCE);
  const table = skillTable();
  assert.deepEqual(
    table.map((r) => `${r.skill}:${r.kind}`).sort(),
    ['dev-implement:context-check', 'dev-qa:reviewer', 'dev-ship:reviewer', 'dev-verify:context-check'],
  );
  for (const { skill, kind, section: sec } of table) {
    const md = read(skillMd(skill));
    assert.deepEqual(
      marked(section(md, sec), kind, `${skill} / ${sec}`),
      marked(ref, kind, 'reference'),
      `${skill} の ${kind} が reference と食い違っている`,
    );
    const link = md.match(/\]\((\.\.\/_shared\/reference\/advisor-policy\.md)\)/);
    assert.ok(link, `${skill}: reference へのリンクが無い`);
    assert.ok(fs.existsSync(path.join(SKILLS, skill, link[1])), `${skill}: リンク先が存在しない`);
  }
});

test('AC5: dev-loop は iteration 境界でコンテキストを測り、超えたら止めて resume を案内する', () => {
  const md = read(skillMd('dev-loop'));
  const stops = section(md, '## 停止条件（優先順、上から評価）');
  assert.match(stops, /^\| \d+ \| `halted-context` \|/m, '停止条件表に halted-context が無い');

  const boundary = section(md, '#### L1.6 iteration カウンタ更新と上限チェック');
  const line = boundary.split('\n').find((l) => l.includes('context-size.mjs'));
  assert.ok(line, 'L1.6 で context-size.mjs を呼んでいない');
  assert.match(line, /`over` が `true` なら `halted-context` で L2 へ/);

  const guide = section(md, '### L2. ループ終了処理').split('\n').find((l) => l.includes('`halted-context`'));
  assert.ok(guide, 'L2 の案内に halted-context が無い');
  assert.match(guide, /`\/clear` してから `\/dev-loop resume`/);
});
