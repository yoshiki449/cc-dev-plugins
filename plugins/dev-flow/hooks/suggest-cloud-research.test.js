// 実行: node --test plugins/dev-flow/hooks/suggest-cloud-research.test.js
//
// suggest-cloud-research.sh は注入型（ブロックしない）なので、出力があるかどうかが挙動のすべて。
// 守るもの: クラウドの WebSearch/WebFetch でだけ案内が出る / 同一セッションで1回 /
// research 環境の子セッションでは沈黙（沈黙しないと子が孫を作り続ける）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(DIR, 'suggest-cloud-research.sh');
const HOOKS_JSON = path.join(DIR, 'hooks.json');
const SKILL = path.join(DIR, '..', 'skills', 'cloud-research', 'SKILL.md');

function tmp(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-research-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

// SKILL.md の正準（HTML コメントで囲んだ1行）から目印を読む。テスト側に転記すると、
// 正準だけ直したときにテストが古いまま通る。
function skillMarker() {
  const m = fs.readFileSync(SKILL, 'utf8').match(/<!-- cloud-research-child-marker -->\n(.+)\n<!-- \/cloud-research-child-marker -->/);
  assert.ok(m, 'SKILL.md に cloud-research-child-marker が無い');
  return m[1];
}

function run(input, { remote = 'true', tmpdir } = {}) {
  const res = spawnSync('bash', [HOOK], {
    input: JSON.stringify({ session_id: 's1', tool_name: 'WebSearch', ...input }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CODE_REMOTE: remote, TMPDIR: tmpdir },
  });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout.trim() ? JSON.parse(res.stdout).hookSpecificOutput.additionalContext : '';
}

// 子セッションの transcript: 最初のユーザーメッセージが目印で始まる（content が文字列 / text ブロックの両形式）
function transcript(t, firstUserText, form = 'string') {
  const f = path.join(tmp(t), 't.jsonl');
  const content = form === 'string' ? firstUserText : [{ type: 'text', text: firstUserText }];
  fs.writeFileSync(f, JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n');
  return f;
}

test('クラウドの WebSearch で cloud-research の案内が出る', (t) => {
  assert.match(run({}, { tmpdir: tmp(t) }), /cloud-research/);
});

test('クラウドの WebFetch でも案内が出る', (t) => {
  assert.match(run({ tool_name: 'WebFetch' }, { tmpdir: tmp(t) }), /cloud-research/);
});

test('ローカル（CLAUDE_CODE_REMOTE が true でない）では沈黙する', (t) => {
  assert.equal(run({}, { remote: 'false', tmpdir: tmp(t) }), '');
  assert.equal(run({}, { remote: '', tmpdir: tmp(t) }), '');
});

test('WebSearch / WebFetch 以外のツールでは沈黙する', (t) => {
  assert.equal(run({ tool_name: 'Bash' }, { tmpdir: tmp(t) }), '');
  assert.equal(run({ tool_name: 'mcp__github__search_code' }, { tmpdir: tmp(t) }), '');
});

test('同一セッションでは1回だけ。WebSearch の後の WebFetch も数える。別セッションでは再び出る', (t) => {
  const d = tmp(t);
  assert.match(run({}, { tmpdir: d }), /cloud-research/);
  assert.equal(run({}, { tmpdir: d }), '');
  assert.equal(run({ tool_name: 'WebFetch' }, { tmpdir: d }), '');
  assert.match(run({ session_id: 's2' }, { tmpdir: d }), /cloud-research/);
});

for (const form of ['string', 'blocks']) {
  test(`research 環境の子セッション（目印で始まるユーザーメッセージ・${form}形式）では沈黙する`, (t) => {
    const f = transcript(t, `${skillMarker()}\n調べたいこと…`, form);
    assert.equal(run({ transcript_path: f }, { tmpdir: tmp(t) }), '');
  });
}

test('親セッションの transcript に目印が現れても（prompt 引数・SKILL.md の読み取り結果）子扱いしない', (t) => {
  const f = path.join(tmp(t), 't.jsonl');
  const marker = skillMarker();
  fs.writeFileSync(f, [
    JSON.stringify({ type: 'user', message: { role: 'user', content: '調べて' } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'create_session', input: { prompt: `${marker}\n調査` } }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: `...\n${marker}\n...` }] } }),
  ].join('\n') + '\n');
  assert.match(run({ transcript_path: f }, { tmpdir: tmp(t) }), /cloud-research/);
});

test('transcript_path が無い・存在しないファイルでも案内は出る（子の判定に失敗してもブロックしない）', (t) => {
  assert.match(run({ transcript_path: '/nonexistent/t.jsonl' }, { tmpdir: tmp(t) }), /cloud-research/);
});

test('hooks.json が WebSearch / WebFetch の PreToolUse で呼び、登録側に条件を書かない', () => {
  const entries = JSON.parse(fs.readFileSync(HOOKS_JSON, 'utf8')).hooks.PreToolUse;
  for (const tool of ['WebSearch', 'WebFetch']) {
    const hit = entries.filter((e) => new RegExp(`^(?:${e.matcher})$`).test(tool));
    const cmds = hit.flatMap((e) => e.hooks.map((h) => h.command));
    const mine = cmds.filter((c) => c.includes('suggest-cloud-research.sh'));
    assert.equal(mine.length, 1, `${tool} で suggest-cloud-research.sh がちょうど1回呼ばれていない`);
    assert.ok(!/CLAUDE_CODE_REMOTE|\[\s/.test(mine[0]), '条件は hook スクリプトの1箇所だけに置く');
  }
});

test('SKILL.md が research 環境を名前で引く（ID を直書きしない）', () => {
  const s = fs.readFileSync(SKILL, 'utf8');
  assert.match(s, /list_environments/);
  assert.doesNotMatch(s, /env_[0-9A-Za-z]{16,}/);
});
