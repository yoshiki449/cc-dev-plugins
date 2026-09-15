#!/usr/bin/env node
'use strict';

// build.workflow.js（auto-build の Finalize）が生成する PR 本文にも、dev-ship E3.5 と同じ
// fail-closed 条件・同じ session-insight マーカーで知見を書き出す指示が入っていることを固定する。
// 実行: node --test plugins/dev-flow/workflows/build-workflow-insight-marker.test.js
//
// なぜ必要か:
//   dev-ship 側の ship-insight-marker.test.mjs は SKILL.md の文言だけを固定しており、
//   build.workflow.js 側の指示がずれても検知できない（Issue #49 セルフレビューで実際に
//   指摘された穴）。両者は同じマーカーを生成する前提なので、build.workflow.js 側も
//   PRIVATE 厳密一致・fail-closed 明示・マーカー言及を独立に固定する。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const WORKFLOW = path.join(__dirname, 'build.workflow.js');
const src = fs.readFileSync(WORKFLOW, 'utf8');

// プロンプト文字列内では ` は \` にエスケープされているので、比較用にアンエスケープする。
const unescaped = src.replace(/\\`/g, '`');

test('知見マーカー行が存在し、PRIVATE 厳密一致（fail-closed）を明示している', () => {
  const line = unescaped
    .split('\n')
    .find((l) => l.includes('知見マーカー（条件付き）'));
  assert.ok(line, 'build.workflow.js に「知見マーカー（条件付き）」の行が見つからない');
  assert.match(
    line,
    /厳密に `PRIVATE` のときだけ/,
    'PRIVATE 厳密一致の条件が緩んでいる、または消えている'
  );
  assert.match(
    line,
    /それ以外（`PUBLIC`／`INTERNAL`／判定失敗を含む）は書かない/,
    'fail-closed（それ以外は書かない）の明示が消えている'
  );
});

test('session-insight マーカーの開始・終了タグに言及している', () => {
  assert.match(unescaped, /<!-- session-insight v1 -->/);
  assert.match(unescaped, /<!-- \/session-insight -->/);
});

test('dev-ship SKILL.md と同じ session-insight マーカー文字列を使っている', () => {
  const skillMd = fs.readFileSync(
    path.join(__dirname, '..', 'skills', 'dev-ship', 'SKILL.md'),
    'utf8'
  );
  const openTag = '<!-- session-insight v1 -->';
  const closeTag = '<!-- /session-insight -->';
  assert.ok(skillMd.includes(openTag) && unescaped.includes(openTag), 'session-insight の開始タグが両ファイルで一致していない');
  assert.ok(skillMd.includes(closeTag) && unescaped.includes(closeTag), 'session-insight の終了タグが両ファイルで一致していない');
});
