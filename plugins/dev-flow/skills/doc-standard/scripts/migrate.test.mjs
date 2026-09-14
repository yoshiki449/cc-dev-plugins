import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import mod from './migrate.js';

const { classifyRootMd, hasFullAgentIgnore, ensureAgentIgnore, processRepo } = mod;

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

test('hasFullAgentIgnore: allowlist 形式（.agent/* ＋ 例外）も既定除外として認める', () => {
  assert.equal(hasFullAgentIgnore('.agent/*\n!.agent/knowledge.md\n'), true);
  assert.equal(hasFullAgentIgnore('/.agent/*\n'), true);
});

test('ensureAgentIgnore: allowlist 形式なら全面行を足さない（足すと例外が効かなくなる）', () => {
  const src = '.agent/*\n!.agent/knowledge.md\n';
  assert.deepEqual(ensureAgentIgnore(src), { content: src, changed: false });
});

// ---- processRepo の統合テスト（一時リポジトリ） ----

function repoWith(gitignore, agentFiles) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-standard-'));
  const g = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a]);
  g('init', '-q');
  for (const f of agentFiles) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), 'x\n');
  }
  g('add', '-f', '--', ...agentFiles);
  fs.writeFileSync(path.join(dir, '.gitignore'), gitignore);
  g('add', '.gitignore');
  g('commit', '-qm', 'init');
  return dir;
}
const tracked = (dir) => execFileSync('git', ['-C', dir, 'ls-files', '--', '.agent'], { encoding: 'utf8' }).split('\n').filter(Boolean).sort();

test('processRepo: allowlist の例外ファイルは追跡したまま、例外外だけ剥がす', () => {
  const gi = '.agent/*\n!.agent/knowledge.md\n!.agent/design/\n';
  const dir = repoWith(gi, ['.agent/knowledge.md', '.agent/design/a.md', '.agent/handover-1.md']);
  processRepo(dir, { dryRun: false, force: true });
  assert.deepEqual(tracked(dir), ['.agent/design/a.md', '.agent/knowledge.md']);
  assert.equal(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), gi);
  assert.ok(fs.existsSync(path.join(dir, '.agent', 'handover-1.md')), 'ローカルのファイルは残す');
});

test('processRepo: 全面除外の .gitignore では従来どおり全部剥がす', () => {
  const dir = repoWith('.agent/\n', ['.agent/knowledge.md', '.agent/handover-1.md']);
  processRepo(dir, { dryRun: false, force: true });
  assert.deepEqual(tracked(dir), []);
});

test('processRepo: .agent の除外が無い .gitignore では全面行を足し、全部剥がす', () => {
  const dir = repoWith('node_modules/\n', ['.agent/knowledge.md']);
  processRepo(dir, { dryRun: false, force: true });
  assert.deepEqual(tracked(dir), []);
  assert.match(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), /^\.agent\/$/m);
});

test('processRepo: dry-run でも、追記予定の全面除外に基づいて剥がす件数を報告する', () => {
  // dry-run は .gitignore を書かないので、git に聞くと「まだ除外されていない」と答えて0件になる
  const dir = repoWith('node_modules/\n', ['.agent/knowledge.md', '.agent/handover-1.md']);
  const r = processRepo(dir, { dryRun: true, force: true });
  assert.ok(r.notes.some((n) => /\.agent\/ 配下 2 ファイルを index から削除/.test(n)), r.notes.join('\n'));
  assert.deepEqual(tracked(dir), ['.agent/handover-1.md', '.agent/knowledge.md'], 'dry-run で実際に剥がしてはいけない');
});
