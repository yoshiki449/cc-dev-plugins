import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import store from './commentStore.js';
import core from '../public/commentCore.js';

const { sidecarPathFor, readComments, writeComments, validateComments, framePathFor } = store;
const { refineLineRange, buildExportJson, buildPromptText, buildVideoPromptText } = core;

test('sidecarPathFor / framePathFor: 対象パスから導出（任意パス不可）', () => {
  assert.equal(sidecarPathFor('/a/b/DESIGN.md'), '/a/b/DESIGN.md.comments.json');
  assert.equal(framePathFor('/a/v.webm', 1500), '/a/v.webm.frame-1500.png');
  assert.throws(() => framePathFor('/a/v.webm', 1.5));
  assert.throws(() => framePathFor('/a/v.webm', -1));
});

test('writeComments → readComments ラウンドトリップ・0件で削除', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-comments-'));
  try {
    const target = path.join(tmp, 'DESIGN.md');
    fs.writeFileSync(target, '# x');
    const comments = [
      { id: 'c1', quote: '設計', startLine: 3, endLine: 3, comment: 'ここを直す', anchor: { startBlockLine: 3 } },
      { id: 'c2', quote: '', startLine: null, endLine: null, comment: '全体の感想' },
    ];
    writeComments(target, comments);
    assert.ok(fs.existsSync(sidecarPathFor(target)));
    const read = readComments(target);
    assert.equal(read.comments.length, 2);
    assert.equal(read.comments[0].comment, 'ここを直す');
    assert.deepEqual(read.comments[0].anchor, { startBlockLine: 3 });
    // 0 件でサイドカー削除
    writeComments(target, []);
    assert.ok(!fs.existsSync(sidecarPathFor(target)));
    assert.deepEqual(readComments(target).comments, []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('validateComments: 不正入力を拒否・未知フィールドを落とす', () => {
  assert.throws(() => validateComments('x'));
  assert.throws(() => validateComments([{ comment: '' }]));
  assert.throws(() => validateComments([{ comment: 1 }]));
  assert.throws(() => validateComments([{ comment: 'ok', startLine: 'a' }]));
  const out = validateComments([{ comment: 'ok', quote: 'q', evil: 'x', __proto__: { hack: 1 } }]);
  assert.equal(out[0].comment, 'ok');
  assert.ok(!('evil' in out[0]));
});

test('壊れたサイドカーは空扱い', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-comments-'));
  try {
    const target = path.join(tmp, 'x.md');
    fs.writeFileSync(sidecarPathFor(target), '{broken json');
    assert.deepEqual(readComments(target).comments, []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---- commentCore（mce 移植の純関数） ----

test('refineLineRange: ブロック内で一意な行に精緻化される', () => {
  const sourceText = '# t\n\nAAA\nBBB\nCCC\n';
  const r = refineLineRange({
    quote: 'BBB',
    sourceText,
    blockStart: 3,
    blockStartEnd: 5,
    blockEnd: 3,
    blockEndEnd: 5,
  });
  assert.deepEqual(r, { startLine: 4, endLine: 4 });
});

test('refineLineRange: 一意でない場合はブロック先頭行にフォールバック（F6b）', () => {
  const sourceText = 'X\nX\nX\n';
  const r = refineLineRange({
    quote: 'X',
    sourceText,
    blockStart: 1,
    blockStartEnd: 3,
    blockEnd: 1,
    blockEndEnd: 3,
  });
  assert.deepEqual(r, { startLine: 1, endLine: 1 });
});

test('buildExportJson: id/anchor を除去し mce 互換になる', () => {
  const json = buildExportJson('/p/DESIGN.md', [
    { id: 'c2', quote: 'b', startLine: 5, endLine: 6, comment: 'B', anchor: { x: 1 } },
    { id: 'c1', quote: 'a', startLine: 2, endLine: 2, comment: 'A', anchor: { x: 1 } },
  ]);
  assert.equal(json.file, '/p/DESIGN.md');
  assert.deepEqual(json.comments[0], { quote: 'a', startLine: 2, endLine: 2, comment: 'A' });
  assert.ok(!('anchor' in json.comments[1]));
});

test('buildPromptText / buildVideoPromptText: 前文＋JSON フェンス', () => {
  const json = buildExportJson('/p/x.md', [{ quote: 'q', startLine: 1, endLine: 1, comment: 'c' }]);
  const text = buildPromptText(json);
  assert.match(text, /修正してください/);
  assert.match(text, /```json\n\{/);
  const vjson = buildExportJson('/p/v.webm', [{ quote: '', startLine: null, endLine: null, comment: 'c', timestamp: 1.5, screenshot: '/p/v.webm.frame-1500.png' }]);
  const vtext = buildVideoPromptText(vjson);
  assert.match(vtext, /E2E テスト動画/);
  assert.match(vtext, /"timestamp": 1\.5/);
  assert.match(vtext, /"screenshot"/);
});
