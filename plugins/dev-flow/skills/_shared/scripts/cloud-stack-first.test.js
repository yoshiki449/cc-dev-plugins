#!/usr/bin/env node
'use strict';

// クラウドでの実スタック確認（_shared/reference/cloud-stack-first.md）のドリフト検出。
// 実行: node --test plugins/dev-flow/skills/_shared/scripts/cloud-stack-first.test.js
//
// 実際に読まれるのは各 SKILL.md の複製なので、正準だけ直しても効かない。語の存在チェックは
// 否定を1文足すだけで通り抜けるため、マーカー内の行を byte-identical で比較する。
// 消費者は _shared/README.md の表から読み、テスト側に配列を持たない。
//
// 実測の動機: クラウドの検証フェーズが「docker が無い」と引継書に書き、次のフェーズがそれを
// 確かめずに写した。実際は cloud-stack の up で dockerd が起動し、スタックは立った。
// 「この文が各フェーズに届いていること」を固定しないと、同じ写し間違いが再発する。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { section } = require('./md-section.js');

const SKILLS = path.join(__dirname, '..', '..');
const REFERENCE = path.join(SKILLS, '_shared', 'reference', 'cloud-stack-first.md');
const README = path.join(SKILLS, '_shared', 'README.md');
const CONSUMER_SECTION = '## クラウドでの実スタック確認の消費者';
const MARKER = /<!-- cloud-stack-first -->/;

// 内訳を固定する。件数を持たないと、表の行を消しても通り、その消費者の検査が空になる。
const EXPECTED_CONSUMERS = 2;

const read = (p) => fs.readFileSync(p, 'utf8');
const skillMd = (name) => path.join(SKILLS, name, 'SKILL.md');

function marked(md, where) {
  const re = /<!-- cloud-stack-first -->\n([\s\S]*?)\n[ \t]*<!-- \/cloud-stack-first -->/;
  const m = md.match(re);
  assert.ok(m, `${where}: cloud-stack-first のマーカーが見つからない`);
  return m[1].split('\n').map((l) => l.replace(/^\s+/, '')).filter(Boolean);
}

function consumers() {
  return section(read(README), CONSUMER_SECTION)
    .split('\n')
    .map((l) => l.match(/^\|\s*`([^`]+)`\s*\|\s*「([^」]+)」\s*\|\s*$/))
    .filter(Boolean)
    .map((m) => ({ skill: m[1], heading: m[2] }));
}

test('AC1: 正準が実行する手順と根拠の置き方を持つ', () => {
  const canon = marked(read(REFERENCE), 'cloud-stack-first.md').join('\n');
  assert.ok(canon.includes('CLAUDE_CODE_REMOTE=true'), 'クラウドの判定条件が無い');
  assert.ok(canon.includes('cloud-stack.sh status'), '状態確認のコマンドが無い');
  assert.ok(canon.includes('up <repo> --wait'), '起動のコマンドが無い');
  assert.ok(canon.includes('実行結果'), '引継書の記述ではなく実行結果を根拠にする指示が無い');
});

test('AC2: 表の件数が固定どおりで、同じスキルの重複が無い', () => {
  const rows = consumers();
  assert.equal(rows.length, EXPECTED_CONSUMERS);
  const names = rows.map((r) => r.skill);
  assert.equal(new Set(names).size, names.length, `重複: ${names.join(', ')}`);
});

test('AC3: 表の全行で、指定の節が正準の文を byte-identical で持つ', () => {
  const canon = marked(read(REFERENCE), 'cloud-stack-first.md');
  assert.ok(canon.length > 0, '正準が空');
  for (const r of consumers()) {
    const body = section(read(skillMd(r.skill)), r.heading);
    const got = marked(body, `${r.skill} の「${r.heading}」`);
    assert.deepEqual(got, canon, `${r.skill} の「${r.heading}」が正準とずれている`);
  }
});

test('AC4: マーカーを持つ SKILL.md は全て表に載っている（表に載せ忘れた複製がずれても検知できる）', () => {
  const listed = new Set(consumers().map((r) => r.skill));
  const withMarker = fs
    .readdirSync(SKILLS)
    .filter((d) => fs.existsSync(skillMd(d)))
    .filter((d) => MARKER.test(read(skillMd(d))));
  assert.deepEqual([...withMarker].sort(), [...listed].sort());
});

test('AC5: 実スタックを起動して確認するフェーズ（dev-verify / dev-qa）は表に載っている（allowlist）', () => {
  const listed = new Set(consumers().map((r) => r.skill));
  for (const d of ['dev-verify', 'dev-qa']) {
    assert.ok(listed.has(d), `${d} は起動済みのアプリを前提にするが、表に無い`);
  }
});
