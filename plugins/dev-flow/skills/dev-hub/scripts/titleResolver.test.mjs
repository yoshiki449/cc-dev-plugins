import { test } from 'node:test';
import assert from 'node:assert/strict';
import mod from './titleResolver.js';

const { extractMdTitle, extractHtmlTitle } = mod;

test('extractMdTitle: 先頭の # 見出しを返す', () => {
  assert.equal(extractMdTitle('# 設計書 v2\n\n本文'), '設計書 v2');
  assert.equal(extractMdTitle('前置き\n\n## サブ見出しだけ\n本文'), 'サブ見出しだけ');
});

test('extractMdTitle: frontmatter をスキップする', () => {
  const md = '---\ntitle: メタ\nname: x\n---\n\n# 本文の見出し\n';
  assert.equal(extractMdTitle(md), '本文の見出し');
});

test('extractMdTitle: コードフェンス内の # は見出し扱いしない', () => {
  const md = '```bash\n# これはコメント\n```\n\n## 実際の見出し\n';
  assert.equal(extractMdTitle(md), '実際の見出し');
});

test('extractMdTitle: 見出しが無ければ null', () => {
  assert.equal(extractMdTitle('ただのテキスト\n箇条書きなし\n'), null);
  assert.equal(extractMdTitle(''), null);
  assert.equal(extractMdTitle(null), null);
});

test('extractMdTitle: 閉じ # を除去する', () => {
  assert.equal(extractMdTitle('## 見出し ##\n'), '見出し');
});

test('extractHtmlTitle: <title> を返す', () => {
  assert.equal(extractHtmlTitle('<html><head><title>変更理解: 認証追加</title></head></html>'), '変更理解: 認証追加');
});

test('extractHtmlTitle: 属性付き・大文字・複数行に対応', () => {
  assert.equal(extractHtmlTitle('<TITLE data-x="1">\n  複数行\n  タイトル\n</TITLE>'), '複数行 タイトル');
});

test('extractHtmlTitle: 基本エンティティをデコードする', () => {
  assert.equal(extractHtmlTitle('<title>A &amp; B &lt;tag&gt; &quot;q&quot; &#39;s&#39;</title>'), 'A & B <tag> "q" \'s\'');
});

test('extractHtmlTitle: <title> が無ければ null', () => {
  assert.equal(extractHtmlTitle('<html><body>no title</body></html>'), null);
  assert.equal(extractHtmlTitle('<title></title>'), null);
  assert.equal(extractHtmlTitle(null), null);
});
