#!/usr/bin/env node
'use strict';

// pick-agent-source.sh のテスト。
// 実行: node --test plugins/dev-flow/skills/_shared/scripts/pick-agent-source.test.js
//
// 動機: dev-setup B1-3 は main clone の `.agent/` を正本とみなしていたが、worktree を連鎖させる
// 運用では main clone のほうが古く（実測: 120 ファイルで 7 日前に止まる）、直前の worktree
// （266 ファイル）にしか引継書が無かった。コピー元は更新日時で選ぶ。

const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.join(__dirname, 'pick-agent-source.sh');

function tmp(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pick-agent-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

// <root>/<name>/.agent に files 個のファイルを置き、全ファイルの mtime を ageDays 日前にする
function agent(root, name, files, ageDays) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, '.agent'), { recursive: true });
  const when = new Date(Date.now() - ageDays * 86400 * 1000);
  for (let i = 0; i < files; i++) {
    const f = path.join(dir, '.agent', `f${i}.md`);
    fs.writeFileSync(f, 'x');
    fs.utimesSync(f, when, when);
  }
  return dir;
}

function run(args) {
  const r = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8' });
  const lines = r.stdout.split('\n').filter(Boolean).map((l) => l.split('\t'));
  return { status: r.status, stderr: r.stderr, lines, chosen: lines.find((l) => l[0] === 'chosen') };
}

test('main clone が古く直前の worktree が新しいときは worktree を選ぶ（main 正本の決め打ちの反転）', (t) => {
  const root = tmp(t);
  const main = agent(root, 'repo', 120, 7);
  const prev = agent(root, 'prev-wt', 5, 0);
  const r = run([main, prev]);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.chosen[1], prev);
});

test('引数の順序に依存しない（main を後ろに置いても同じ結果）', (t) => {
  const root = tmp(t);
  const main = agent(root, 'repo', 120, 7);
  const prev = agent(root, 'prev-wt', 5, 0);
  assert.strictEqual(run([prev, main]).chosen[1], prev);
});

test('main clone のほうが新しければ main を選ぶ（常に worktree 優先ではない）', (t) => {
  const root = tmp(t);
  const main = agent(root, 'repo', 3, 0);
  const prev = agent(root, 'prev-wt', 266, 7);
  assert.strictEqual(run([main, prev]).chosen[1], main);
});

test('全候補を candidate 行に出す（根拠を完了報告に書けるように）', (t) => {
  const root = tmp(t);
  const main = agent(root, 'repo', 4, 7);
  const prev = agent(root, 'prev-wt', 2, 0);
  const cands = run([main, prev]).lines.filter((l) => l[0] === 'candidate');
  assert.deepStrictEqual(cands.map((c) => [c[1], c[2]]), [[main, '4'], [prev, '2']]);
});

test('更新時刻が同じならファイル数が多いほうを選ぶ', (t) => {
  const root = tmp(t);
  const a = agent(root, 'a', 2, 1);
  const b = agent(root, 'b', 9, 1);
  const when = new Date(Date.now() - 86400 * 1000);
  for (const d of [a, b]) for (const f of fs.readdirSync(path.join(d, '.agent'))) fs.utimesSync(path.join(d, '.agent', f), when, when);
  assert.strictEqual(run([a, b]).chosen[1], b);
});

test('.agent が無い・空の候補は読み飛ばす', (t) => {
  const root = tmp(t);
  const empty = agent(root, 'new-wt', 0, 0);
  fs.mkdirSync(path.join(root, 'noagent'));
  const main = agent(root, 'repo', 3, 2);
  const r = run([empty, path.join(root, 'noagent'), main]);
  assert.strictEqual(r.chosen[1], main);
  assert.strictEqual(r.lines.filter((l) => l[0] === 'candidate').length, 1);
});

test('symlink の .agent も向き先の中身で判定する', (t) => {
  const root = tmp(t);
  const real = agent(root, 'real', 4, 0);
  const link = path.join(root, 'link');
  fs.mkdirSync(link);
  fs.symlinkSync(path.join(real, '.agent'), path.join(link, '.agent'));
  const old = agent(root, 'old', 50, 9);
  assert.strictEqual(run([old, link]).chosen[1], link);
});

test('候補が無ければ exit 3、引数が無ければ exit 2', (t) => {
  const root = tmp(t);
  assert.strictEqual(run([path.join(root, 'none')]).status, 3);
  assert.strictEqual(run([]).status, 2);
});
