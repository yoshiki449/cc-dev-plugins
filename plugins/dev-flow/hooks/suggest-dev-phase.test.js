// 実行: node --test plugins/dev-flow/hooks/suggest-dev-phase.test.js
//
// suggest-dev-phase.sh は注入型（ブロックしない）なので、出力があるかどうかが挙動のすべて。
// クラウドでは gh が無く Issue を GitHub MCP の issue_write で作るうえ、毎回新しい clone で
// .agent/ が無い。この2点のどちらが欠けても dev-plan の案内は出ない。

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'suggest-dev-phase.sh');
const HOOKS_JSON = path.join(path.dirname(fileURLToPath(import.meta.url)), 'hooks.json');
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };

function tmp(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'suggest-phase-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

// agent: .agent/ を作るか。poc: .poc/ を作るか。
function makeRepo(t, { agent = false, poc = false, branch = 'claude/x' } = {}) {
  const dir = tmp(t);
  const g = (a) => execFileSync('git', a, { cwd: dir, env: GIT_ENV, encoding: 'utf8' });
  g(['init', '-q', '-b', 'main']);
  g(['config', 'user.name', 't']);
  g(['config', 'user.email', 't@t']);
  g(['commit', '-q', '--allow-empty', '-m', 'init']);
  g(['checkout', '-q', '-b', branch]);
  if (agent) fs.mkdirSync(path.join(dir, '.agent'));
  if (poc) fs.mkdirSync(path.join(dir, '.poc'));
  return dir;
}

// remote: CLAUDE_CODE_REMOTE の値。TMPDIR はミュートファイルの置き場をテストごとに分ける。
function run(input, { remote = 'false', tmpdir } = {}) {
  const res = spawnSync('bash', [HOOK], {
    input: JSON.stringify({ session_id: 's1', ...input }),
    encoding: 'utf8',
    env: { ...GIT_ENV, CLAUDE_CODE_REMOTE: remote, TMPDIR: tmpdir },
  });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout.trim() ? JSON.parse(res.stdout).hookSpecificOutput.additionalContext : '';
}

const mcpCreate = (cwd) => ({ tool_name: 'mcp__github__issue_write', cwd, tool_input: { method: 'create', owner: 'o', repo: 'r' } });

test('クラウド・.agent/ 無し: issue_write(create) で dev-plan の案内が出る', (t) => {
  const msg = run(mcpCreate(makeRepo(t)), { remote: 'true', tmpdir: tmp(t) });
  assert.match(msg, /dev-plan/);
});

test('クラウド・cwd が git リポジトリではない: 作成先は tool_input で決まるので案内が出る', (t) => {
  const msg = run(mcpCreate(tmp(t)), { remote: 'true', tmpdir: tmp(t) });
  assert.match(msg, /dev-plan/);
});

test('同一セッションでは1回だけ（2回目は沈黙）', (t) => {
  const td = tmp(t);
  const repo = makeRepo(t);
  assert.match(run(mcpCreate(repo), { remote: 'true', tmpdir: td }), /dev-plan/);
  assert.equal(run(mcpCreate(repo), { remote: 'true', tmpdir: td }), '');
});

test('method=update は Issue 作成ではないので沈黙', (t) => {
  const input = mcpCreate(makeRepo(t));
  input.tool_input.method = 'update';
  assert.equal(run(input, { remote: 'true', tmpdir: tmp(t) }), '');
});

test('ローカル・.agent/ 無し: 従来どおり沈黙（dev-flow を使っていないリポジトリを黙らせるガード）', (t) => {
  assert.equal(run(mcpCreate(makeRepo(t)), { remote: 'false', tmpdir: tmp(t) }), '');
});

test('ローカル・.agent/ あり: issue_write(create) で案内が出る', (t) => {
  const msg = run(mcpCreate(makeRepo(t, { agent: true })), { remote: 'false', tmpdir: tmp(t) });
  assert.match(msg, /dev-plan/);
});

test('クラウドでも .poc/ がある PoC リポジトリは沈黙', (t) => {
  assert.equal(run(mcpCreate(makeRepo(t, { poc: true })), { remote: 'true', tmpdir: tmp(t) }), '');
});

test('dev-plan 実行中（マーカーが現ブランチと一致）は沈黙', (t) => {
  const repo = makeRepo(t, { agent: true, branch: 'claude/y' });
  fs.writeFileSync(path.join(repo, '.agent', '.dev-flow-active'), 'claude/y\n');
  assert.equal(run(mcpCreate(repo), { remote: 'true', tmpdir: tmp(t) }), '');
});

test('gh issue create も、クラウドの .agent/ 無しで案内が出る', (t) => {
  const input = { tool_name: 'Bash', cwd: makeRepo(t), tool_input: { command: 'gh issue create --title x' } };
  assert.match(run(input, { remote: 'true', tmpdir: tmp(t) }), /dev-plan/);
});

test('gh issue create も、クラウドの .poc/ がある PoC リポジトリでは沈黙', (t) => {
  const input = { tool_name: 'Bash', cwd: makeRepo(t, { poc: true }), tool_input: { command: 'gh issue create --title x' } };
  assert.equal(run(input, { remote: 'true', tmpdir: tmp(t) }), '');
});

test('gh issue create はローカルの .agent/ 無しでは沈黙（回帰）', (t) => {
  const input = { tool_name: 'Bash', cwd: makeRepo(t), tool_input: { command: 'gh issue create --title x' } };
  assert.equal(run(input, { remote: 'false', tmpdir: tmp(t) }), '');
});

test('コード書込の案内は .agent/ 必須のまま（クラウドの .agent/ 無しでは出さない）', (t) => {
  const repo = makeRepo(t);
  const input = { tool_name: 'Write', cwd: repo, tool_input: { file_path: path.join(repo, 'a.ts') } };
  assert.equal(run(input, { remote: 'true', tmpdir: tmp(t) }), '');
  fs.mkdirSync(path.join(repo, '.agent'));
  assert.match(run(input, { remote: 'true', tmpdir: tmp(t) }), /dev-implement/);
});

test('hooks.json が issue_write の PreToolUse で suggest-dev-phase.sh を呼ぶ', () => {
  const entries = JSON.parse(fs.readFileSync(HOOKS_JSON, 'utf8')).hooks.PreToolUse;
  const hit = entries.filter((e) => new RegExp(`^(?:${e.matcher})$`).test('mcp__github__issue_write'));
  assert.ok(hit.length > 0, 'issue_write にマッチする matcher が無い');
  assert.ok(
    hit.some((e) => e.hooks.some((h) => h.command.includes('suggest-dev-phase.sh'))),
    'issue_write のマッチャーが suggest-dev-phase.sh を呼んでいない'
  );
});
