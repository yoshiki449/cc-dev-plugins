#!/usr/bin/env node
'use strict';

// resume-prompt.sh のテスト。
// 実行: node --test plugins/dev-flow/skills/_shared/scripts/resume-prompt.test.js
//
// /clear の後に貼る再開プロンプトを組み立てるスクリプト。貼られた引継書パスは次フェーズが
// 探索せずに読むので、ここで古い引継書（日付なしの handover-issue62.md など）を選ぶと
// 「前回の内容が失われる」が /clear のたびに再発する。AC2 は latest-handover.sh の
// 旧実装（辞書順）に戻すと落ちる。

const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.join(__dirname, 'resume-prompt.sh');

function fixture(files) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'resume-prompt-')));
  fs.mkdirSync(path.join(dir, '.agent'));
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, '.agent', name), body ?? `# ${name}\n`);
  }
  return dir;
}

function run(dir, args) {
  const r = spawnSync('bash', [SCRIPT, ...args], { cwd: dir, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, lines: r.stdout.split('\n') };
}

test('AC1: 1行目は「/<次フェーズ> 引継書: <絶対パス>」で、日付つきの最新を指す', () => {
  const dir = fixture({
    'handover-20261005-0900-issue10.md': null,
    'handover-20261007-1619-issue496.md': null,
  });
  const r = run(dir, ['dev-fix']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.lines[0], `/dev-fix 引継書: ${path.join(dir, '.agent', 'handover-20261007-1619-issue496.md')}`);
});

test('AC2: 日付なしの引継書が混ざっていても、日付つきの最新を選ぶ（旧方式 ls | tail -1 の回帰）', () => {
  const dir = fixture({
    'handover-issue62.md': null,
    'handover-20261007-1619-issue496.md': null,
    'handover-20261001-1000-issue55.md': null,
  });
  const r = run(dir, ['dev-qa']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.lines[0].endsWith('handover-20261007-1619-issue496.md'), r.lines[0]);
  assert.ok(!r.stdout.includes('handover-issue62'), '日付なしの引継書を選んではいけない');
});

test('AC3: 引継書パスを明示すると、探索結果より優先する。相対パスは絶対パスにする', () => {
  const dir = fixture({
    'handover-20261001-1000-issue55.md': null,
    'handover-20261007-1619-issue496.md': null,
  });
  const r = run(dir, ['dev-verify', '.agent/handover-20261001-1000-issue55.md']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.lines[0], `/dev-verify 引継書: ${path.join(dir, '.agent', 'handover-20261001-1000-issue55.md')}`);
});

test('AC4: 引継書が1件も無ければ、理由つきで exit 1（空の出力で成功にしない）', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'resume-prompt-empty-')));
  const r = run(dir, ['dev-fix']);
  assert.equal(r.status, 1);
  assert.equal(r.stdout.trim(), '');
  assert.match(r.stderr, /引継書が見つからない/);
});

test('AC5: 明示した引継書パスが存在しなければ exit 1', () => {
  const dir = fixture({ 'handover-20261007-1619-issue496.md': null });
  const r = run(dir, ['dev-fix', '.agent/handover-nothing.md']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /読めない/);
});

test('AC6: スキル名の先頭スラッシュは吐き出さず1つに正規化し、不正な名前は exit 2', () => {
  const dir = fixture({ 'handover-20261007-1619-issue496.md': null });
  const ok = run(dir, ['/dev-fix']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(ok.lines[0].startsWith('/dev-fix 引継書: '), ok.lines[0]);

  for (const bad of ['', 'Dev Fix', 'dev-fix; rm -rf /', '../x']) {
    const r = run(dir, [bad]);
    assert.equal(r.status, 2, `「${bad}」は拒否する`);
  }
});

test('AC7: 2行目に作業場所（引継書の worktree 絶対パス欄を優先）と Issue 番号を出す', () => {
  const dir = fixture({
    'handover-20261007-1619-issue496.md':
      '# 引継書\n\n## worktree 情報\n- **worktree 絶対パス**: `/work/proj/worktrees/fix-496/` ← 次フェーズはここに cd\n',
  });
  const r = run(dir, ['dev-verify']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.lines[1], /^作業場所: \/work\/proj\/worktrees\/fix-496\//);
  assert.match(r.lines[1], /Issue: #496/);
});

test('AC8: worktree 欄が未記入のテンプレートのまま（<...>）なら採用せず、cwd にフォールバックする', () => {
  const dir = fixture({
    'handover-20261007-1619-issue496.md':
      '- **worktree 絶対パス**: `<project-folder>/worktrees/<branch-basename>/`\n',
  });
  const r = run(dir, ['dev-verify']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.lines[1].includes('<project-folder>'), r.lines[1]);
  assert.ok(r.lines[1].includes(dir), `cwd にフォールバックする: ${r.lines[1]}`);
});
