#!/usr/bin/env node
'use strict';

// /dev-run の前提チェック run-preconditions.sh の振る舞いテスト。
// 実行: node --test plugins/dev-flow/skills/_shared/scripts/run-preconditions.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'run-preconditions.sh');

const roots = [];
function repo(branch) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'run-pre-'));
  roots.push(d);
  spawnSync('git', ['init', '-q', '-b', branch], { cwd: d });
  fs.mkdirSync(path.join(d, '.agent'));
  return d;
}
function handover(d, name, phase, body = '') {
  fs.writeFileSync(path.join(d, '.agent', name), `# 引継書 - ${phase} - 2026-01-01 00:00\n${body}`);
}
function run(d, route) {
  const r = spawnSync('bash', [SCRIPT, route, d], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}
test.after(() => roots.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const DESIGN_YES = '## 画面デザインフェーズ判定\n- design フェーズ推奨: yes\n';
const DESIGN_NO = '## 画面デザインフェーズ判定\n- design フェーズ推奨: no\n';

test('plan から始まる経路は引継書が無くても通る', () => {
  assert.deepEqual(run(repo('feat-issue5'), 'plan,setup,implement').missing, []);
});

test('implement 始まりで plan の引継書が無ければ plan 不足', () => {
  const r = run(repo('feat-issue5'), 'implement,verify,ship');
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['plan']);
});

test('別 Issue の plan 引継書は数えない', () => {
  const d = repo('feat-issue5');
  handover(d, 'handover-20260101-0000-issue6.md', 'plan');
  assert.deepEqual(run(d, 'implement,verify').missing, ['plan']);
});

test('plan 引継書があれば通る（design 不要）', () => {
  const d = repo('feat-issue5');
  handover(d, 'handover-20260101-0000-issue5.md', 'plan', DESIGN_NO);
  assert.equal(run(d, 'implement,verify').ok, true);
});

test('plan が design 推奨 yes で design 未実施なら design 不足', () => {
  const d = repo('feat-issue5');
  handover(d, 'handover-20260101-0000-issue5.md', 'plan', DESIGN_YES);
  assert.deepEqual(run(d, 'setup,implement').missing, ['design']);
});

test('design が経路に含まれるか、design 引継書があれば通る', () => {
  const d = repo('feat-issue5');
  handover(d, 'handover-20260101-0000-issue5.md', 'plan', DESIGN_YES);
  assert.equal(run(d, 'design,setup,implement').ok, true);
  handover(d, 'handover-20260101-0100-issue5.md', 'design');
  assert.equal(run(d, 'setup,implement').ok, true);
});

test('fix / verify 始まり（バグ修正・途中再開）は plan を要求しない', () => {
  const d = repo('feat-issue5');
  assert.equal(run(d, 'fix,verify,ship').ok, true);
  assert.equal(run(d, 'verify,qa,ship').ok, true);
});

test('ブランチから Issue を特定できないときは全体を見て警告する', () => {
  const d = repo('main');
  handover(d, 'handover-20260101-0000-issue9.md', 'plan', DESIGN_NO);
  const r = run(d, 'implement');
  assert.equal(r.ok, true);
  assert.equal(r.warnings.length, 1);
});

test('不正なフェーズ列は ok=false（コマンド注入を通さない）', () => {
  const r = run(repo('feat-issue5'), 'implement;rm -rf');
  assert.equal(r.ok, false);
});
