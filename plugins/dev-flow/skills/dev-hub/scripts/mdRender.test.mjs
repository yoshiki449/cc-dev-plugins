import { test } from 'node:test';
import assert from 'node:assert/strict';
import mod from '../public/mdRender.js';

const { renderMarkdown, escapeHtml } = mod;

test('見出し・段落・強調', () => {
  const html = renderMarkdown('# タイトル\n\n本文 **強調** と *斜体* と `code`。');
  assert.match(html, /<h1[^>]*>タイトル<\/h1>/);
  assert.match(html, /<strong>強調<\/strong>/);
  assert.match(html, /<em>斜体<\/em>/);
  assert.match(html, /<code>code<\/code>/);
});

test('リスト（ul/ol・ネスト・チェックボックス）', () => {
  const html = renderMarkdown('- a\n  - a1\n- b\n\n1. one\n2. two\n\n- [ ] todo\n- [x] done');
  assert.match(html, /<ul>[\s\S]*<li[^>]*>a<\/li>[\s\S]*<ul>[\s\S]*<li[^>]*>a1<\/li>/);
  assert.match(html, /<ol>[\s\S]*<li[^>]*>one<\/li>/);
  assert.match(html, /☐/);
  assert.match(html, /☑/);
});

test('フェンスコードブロック内は変換されない', () => {
  const html = renderMarkdown('```\n**not bold** # not heading\n```');
  assert.match(html, /<pre[^>]*><code>/);
  assert.match(html, /\*\*not bold\*\* # not heading/);
  assert.doesNotMatch(html, /<strong>/);
});

test('テーブル（separator 必須）', () => {
  const html = renderMarkdown('| A | B |\n|---|---|\n| 1 | 2 |');
  assert.match(html, /<table[^>]*>\n<thead><tr[^>]*>/);
  assert.match(html, /<th>A<\/th>/);
  assert.match(html, /<td>2<\/td>/);
  // separator が無ければテーブル化しない
  assert.doesNotMatch(renderMarkdown('| A | B |\n| 1 | 2 |'), /<table/);
});

test('リンク: 安全スキームのみ <a> 化', () => {
  const html = renderMarkdown('[ok](https://example.com) [bad](javascript:alert(1)) [rel](./x.md)');
  assert.match(html, /<a href="https:\/\/example\.com" target="_blank" rel="noopener noreferrer">ok<\/a>/);
  assert.doesNotMatch(html, /href="javascript:/);
  assert.doesNotMatch(html, /href="\.\/x\.md"/);
});

test('引用と水平線', () => {
  const html = renderMarkdown('> 引用文\n\n---');
  assert.match(html, /<blockquote[^>]*>[\s\S]*引用文/);
  assert.match(html, /<hr[^>]*>/);
});

test('XSS: script タグは実体参照化される', () => {
  const html = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>');
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;script&gt;/);
});

test('XSS: 見出し・テーブルセル内のタグもエスケープされる', () => {
  const html = renderMarkdown('# <b>x</b>\n\n| <i>c</i> |\n|---|\n| <u>v</u> |');
  assert.doesNotMatch(html, /<b>|<i>|<u>/);
});

test('escapeHtml: 基本4文字', () => {
  assert.equal(escapeHtml('<a href="x">&'), '&lt;a href=&quot;x&quot;&gt;&amp;');
});

test('空入力・null は空文字列', () => {
  assert.equal(renderMarkdown(''), '');
  assert.equal(renderMarkdown(null), '');
});

// ---- data-source-line（コメントエンジン用の行番号注釈） ----

test('data-source-line: 見出しと段落（1始まり・複数行段落は範囲）', () => {
  const html = renderMarkdown('# 見出し\n\n1行目\n2行目\n\n次の段落');
  assert.match(html, /<h1 data-source-line="1" data-source-line-end="1">/);
  assert.match(html, /<p data-source-line="3" data-source-line-end="4">1行目 2行目<\/p>/);
  assert.match(html, /<p data-source-line="6" data-source-line-end="6">次の段落<\/p>/);
});

test('data-source-line: コードブロックはフェンス行を含む範囲', () => {
  const html = renderMarkdown('前文\n\n```\ncode1\ncode2\n```\n\n後文');
  assert.match(html, /<pre data-source-line="3" data-source-line-end="6"><code>/);
});

test('data-source-line: テーブルは全体範囲＋行ごとの tr', () => {
  const html = renderMarkdown('| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |');
  assert.match(html, /<table data-source-line="1" data-source-line-end="4">/);
  assert.match(html, /<tr data-source-line="1" data-source-line-end="1">/); // ヘッダ行
  assert.match(html, /<tr data-source-line="3" data-source-line-end="3">/);
  assert.match(html, /<tr data-source-line="4" data-source-line-end="4">/);
});

test('data-source-line: リスト項目は行単位', () => {
  const html = renderMarkdown('- one\n- two\n  - nested');
  assert.match(html, /<li data-source-line="1" data-source-line-end="1">one<\/li>/);
  assert.match(html, /<li data-source-line="2" data-source-line-end="2">two<\/li>/);
  assert.match(html, /<li data-source-line="3" data-source-line-end="3">nested<\/li>/);
});

test('data-source-line: 引用は範囲・内部 p は行単位', () => {
  const html = renderMarkdown('> 一行目\n> 二行目');
  assert.match(html, /<blockquote data-source-line="1" data-source-line-end="2">/);
  assert.match(html, /<p data-source-line="2" data-source-line-end="2">二行目<\/p>/);
});

test('data-source-line: 閉じられていないコードブロックは末尾行まで', () => {
  const html = renderMarkdown('```\nabc');
  assert.match(html, /<pre data-source-line="1" data-source-line-end="2"><code>/);
});
