#!/usr/bin/env node
'use strict';

// 再開プロンプトと引継書の読み方（_shared/reference/handover-template.md）のドリフト検出。
// 実行: node --test plugins/dev-flow/skills/_shared/scripts/resume-prompt-docs.test.js
//
// 実際に読まれるのは各 SKILL.md の複製なので、正準だけ直しても効かない。語の存在チェックは
// 否定を1文足すだけで通り抜けるため、マーカー内の行を byte-identical で比較する。
// 消費者は _shared/README.md の表から読み、テスト側に配列を持たない。
//
// 旧方式（ls -1 .agent/handover-*.md | tail -1）は、日付なしの引継書（handover-issue62.md など）を
// 末尾に並べて古い引継書を「最新」として返す。#52 で latest-handover.sh に直したが 6 箇所が残り、
// /clear 後に別 Issue の引継書を読む原因になった。denylist は別の書き方で素通りするため、
// 「引継書を読む節は表に載っていること」を allowlist 側の主検査にする。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { section } = require('./md-section.js');

const SKILLS = path.join(__dirname, '..', '..');
const TEMPLATE = path.join(SKILLS, '_shared', 'reference', 'handover-template.md');
const README = path.join(SKILLS, '_shared', 'README.md');
const CONSUMER_SECTION = '## 再開プロンプトの消費者';

// 内訳まで固定する。合計だけだと、ある行の種別を書き換えても通り、その種別の検査が空ループになる。
const EXPECTED = { show: 8, read: 10 };

const read = (p) => fs.readFileSync(p, 'utf8');
const skillMd = (name) => path.join(SKILLS, name, 'SKILL.md');

function marked(md, kind, where) {
  const re = new RegExp(`<!-- resume-prompt:${kind} -->\\n([\\s\\S]*?)\\n[ \\t]*<!-- /resume-prompt:${kind} -->`);
  const m = md.match(re);
  assert.ok(m, `${where}: resume-prompt:${kind} のマーカーが見つからない`);
  return m[1].split('\n').map((l) => l.replace(/^\s+/, '')).filter(Boolean);
}

function consumers() {
  return section(read(README), CONSUMER_SECTION)
    .split('\n')
    .map((l) => l.match(/^\|\s*`([^`]+)`\s*\|\s*(show|read)\s*\|\s*「([^」]+)」\s*\|\s*$/))
    .filter(Boolean)
    .map((m) => ({ skill: m[1], kind: m[2], heading: m[3] }));
}

test('AC1: 表の内訳が固定どおりで、同じ（スキル, 種別）の重複が無い', () => {
  const rows = consumers();
  const count = { show: 0, read: 0 };
  for (const r of rows) count[r.kind] += 1;
  assert.deepEqual(count, EXPECTED);
  const keys = rows.map((r) => `${r.skill}/${r.kind}`);
  assert.equal(new Set(keys).size, keys.length, `重複: ${keys.join(', ')}`);
});

test('AC2: 表の全行で、指定の節が正準の1文を byte-identical で持つ', () => {
  const tpl = read(TEMPLATE);
  const canon = { show: marked(tpl, 'show', 'handover-template.md'), read: marked(tpl, 'read', 'handover-template.md') };
  assert.ok(canon.show.length > 0 && canon.read.length > 0, '正準が空');
  for (const r of consumers()) {
    const body = section(read(skillMd(r.skill)), r.heading);
    const got = marked(body, r.kind, `${r.skill} の「${r.heading}」`);
    assert.deepEqual(got, canon[r.kind], `${r.skill} の「${r.heading}」の ${r.kind} が正準とずれている`);
  }
});

test('AC3: マーカーを持つ SKILL.md は全て表に載っている（表に載せ忘れた複製がずれても検知できる）', () => {
  const listed = new Set(consumers().map((r) => r.skill));
  const withMarker = fs
    .readdirSync(SKILLS)
    .filter((d) => fs.existsSync(skillMd(d)))
    .filter((d) => /<!-- resume-prompt:(show|read) -->/.test(read(skillMd(d))));
  assert.deepEqual([...withMarker].sort(), [...listed].sort());
});

test('AC4: 「引継書を読み込む」節を持つ SKILL.md は、全て read として表に載っている（allowlist）', () => {
  const readers = new Set(consumers().filter((r) => r.kind === 'read').map((r) => r.skill));
  const heading = /^#{2,4} .*引継書(を|の).*読み込/m;
  const found = fs
    .readdirSync(SKILLS)
    .filter((d) => fs.existsSync(skillMd(d)))
    .filter((d) => heading.test(read(skillMd(d))));
  assert.ok(found.length > 0, '見出しの正規表現が何にも当たらない（検査が空）');
  for (const d of found) assert.ok(readers.has(d), `${d} は引継書を読む節を持つが、表の read に無い`);
});

test('AC5: どの SKILL.md にも旧方式 ls -1 .agent/handover が残っていない', () => {
  const offenders = fs
    .readdirSync(SKILLS)
    .filter((d) => fs.existsSync(skillMd(d)))
    .filter((d) => /ls\s+-1t?\s+\.agent\/handover/.test(read(skillMd(d))));
  assert.deepEqual(offenders, []);
});
