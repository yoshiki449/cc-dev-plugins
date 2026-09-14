import { test } from 'node:test';
import assert from 'node:assert/strict';
import mod from './migrate.js';

const { classifyRootMd, hasFullAgentIgnore, ensureAgentIgnore } = mod;

test('classifyRootMd: 許可リスト（大文字小文字を無視）', () => {
  for (const name of ['README.md', 'CLAUDE.md', 'AGENTS.md', 'GEMINI.md',
    'LICENSE.md', 'CONTRIBUTING.md', 'CHANGELOG.md', 'CODE_OF_CONDUCT.md', 'SECURITY.md',
    'readme.md', 'Readme.md']) {
    assert.equal(classifyRootMd(name), 'allowed', name);
  }
});

test('classifyRootMd: 設計系は design', () => {
  for (const name of ['REQUIREMENTS.md', 'DESIGN.md', 'SPEC.md',
    'DESIGN-phase3.md', 'DESIGN-p2.md', 'REQUIREMENTS-forms-distribution.md',
    'DESIGN_chat.md', 'OPERATIONS.md', 'RUNBOOK.md', 'design.md']) {
    assert.equal(classifyRootMd(name), 'design', name);
  }
});

test('classifyRootMd: HANDOVER 系は agent', () => {
  assert.equal(classifyRootMd('HANDOVER.md'), 'agent');
  assert.equal(classifyRootMd('handover-20260415-1345.md'), 'agent');
});

test('classifyRootMd: 許可リスト外・非設計系は manual', () => {
  for (const name of ['STATUS.md', 'TASKS.md', 'PLAN.md', 'FULLSTACK_TEST.md',
    'カレンダー表記ルール.md', 'DEVELOPMENT.md', 'IMPLEMENTATION_PLAN.md']) {
    assert.equal(classifyRootMd(name), 'manual', name);
  }
});

test('classifyRootMd: md 以外は ignore', () => {
  assert.equal(classifyRootMd('package.json'), 'ignore');
  assert.equal(classifyRootMd('DESIGN.md.comments.json'), 'ignore');
});

test('hasFullAgentIgnore: 全面除外の各記法を認識する', () => {
  assert.equal(hasFullAgentIgnore('.agent/\n'), true);
  assert.equal(hasFullAgentIgnore('.agent\n'), true);
  assert.equal(hasFullAgentIgnore('/.agent/\n'), true);
  assert.equal(hasFullAgentIgnore('node_modules/\n.agent/\n'), true);
});

test('hasFullAgentIgnore: 部分除外は全面と見なさない', () => {
  assert.equal(hasFullAgentIgnore('.agent/handover-*.md\n'), false);
  assert.equal(hasFullAgentIgnore('.agent/handovers/\n'), false);
  assert.equal(hasFullAgentIgnore(''), false);
});

test('ensureAgentIgnore: 未設定なら追記される', () => {
  const r = ensureAgentIgnore('node_modules/\n');
  assert.equal(r.changed, true);
  assert.match(r.content, /^\.agent\/$/m);
  assert.match(r.content, /node_modules\//);
});

test('ensureAgentIgnore: 部分除外のみなら全面行を追記する', () => {
  const r = ensureAgentIgnore('.agent/handover-*.md\n');
  assert.equal(r.changed, true);
  assert.match(r.content, /^\.agent\/$/m);
});

test('ensureAgentIgnore: idempotent（既にあれば無変更）', () => {
  const first = ensureAgentIgnore('dist/\n');
  const second = ensureAgentIgnore(first.content);
  assert.equal(second.changed, false);
  assert.equal(second.content, first.content);
});

test('ensureAgentIgnore: 末尾改行がないファイルでも壊れない', () => {
  const r = ensureAgentIgnore('dist/');
  assert.equal(r.changed, true);
  assert.match(r.content, /dist\/\n/);
  assert.match(r.content, /^\.agent\/$/m);
});
