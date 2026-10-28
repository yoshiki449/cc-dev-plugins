#!/usr/bin/env node
'use strict';

// 差分の比較元の直書き（main...HEAD など）が SKILL.md・エージェント・workflow に戻っていないかを
// 検証する（Issue #12 の E9）。
// 実行: node --test plugins/dev-flow/skills/_shared/scripts/diff-base-drift.test.js
//
// 直書きは、統合ブランチが develop のリポジトリや、ローカルの main が古い worktree 運用で
// 無関係な変更を静かに拾う。比較元は resolve-base-ref.sh が決め、文書には <BASE> と書く。
// skill-md-gate-tables.test.js と同じ方針で、スクリプトの写しではなく文書そのものを読む。
//
// 禁止の説明として引用する箇所だけ ALLOWLIST に入れる（ファイル単位ではなく行の部分文字列で、
// 許可する理由を書く）。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PLUGIN_DIR = path.join(__dirname, '..', '..', '..');

// main / master / develop / trunk（origin/ 付きも）を起点にした範囲指定。
const HARDCODED = /(?<![\w./-])(?:origin\/)?(?:main|master|develop|trunk)\.\.\.?(?:HEAD|[\w-]+\/[\w./-]+|feature)/;

const ALLOWLIST = [
  // 比較元の決め方の説明文が、禁止する書き方を引用している
  { file: 'skills/_shared/reference/base-ref.md', includes: '`main...HEAD` のように起点を直書きしない' },
];

function listFiles(dir, exts) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listFiles(full, exts));
    else if (exts.some((e) => ent.name.endsWith(e)) && !/\.test\./.test(ent.name)) out.push(full);
  }
  return out;
}

function findHardcoded(rel, text) {
  const hits = [];
  text.split('\n').forEach((line, i) => {
    if (!HARDCODED.test(line)) return;
    if (ALLOWLIST.some((a) => a.file === rel && line.includes(a.includes))) return;
    hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
  });
  return hits;
}

test('E9: SKILL.md・エージェント・workflow・参照文書に差分起点の直書きが無い', () => {
  const files = [
    ...listFiles(path.join(PLUGIN_DIR, 'skills'), ['.md']),
    ...listFiles(path.join(PLUGIN_DIR, 'agents'), ['.md']),
    ...listFiles(path.join(PLUGIN_DIR, 'workflows'), ['.js']),
  ];
  assert.ok(files.length > 20, `対象ファイルが少なすぎる（走査が壊れている）: ${files.length}`);
  const hits = files.flatMap((f) =>
    findHardcoded(path.relative(PLUGIN_DIR, f).split(path.sep).join('/'), fs.readFileSync(f, 'utf8')),
  );
  assert.deepEqual(
    hits,
    [],
    `差分起点が直書きされている。<BASE> を使い、resolve-base-ref.sh の出力を渡すこと（skills/_shared/reference/base-ref.md）:\n${hits.join('\n')}`,
  );
});

test('検出器の自己検証: 直書きを検出し、<BASE> や無関係な範囲指定は検出しない', () => {
  const bad = [
    'git diff main...HEAD',
    'git diff origin/main..HEAD',
    '差分起点 `origin/master...HEAD`',
    'git log --oneline main..HEAD',
    'git diff origin/develop..feature/foo',
    'git diff origin/main..feature/foo',
  ];
  for (const line of bad) assert.equal(findHardcoded('x.md', line).length, 1, `検出できない: ${line}`);
  const good = [
    'git diff <BASE>...HEAD',
    'git diff "$BASE"...HEAD',
    'git log ${attemptStartShaClean}..HEAD',
    'git diff <attempt_start_sha>..HEAD',
    'git log origin/<対象ブランチ>..HEAD --oneline',
    'git diff 4479b93..HEAD',
  ];
  for (const line of good) assert.equal(findHardcoded('x.md', line).length, 0, `誤検出: ${line}`);
});
