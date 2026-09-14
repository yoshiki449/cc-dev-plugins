'use strict';

// md / HTML ファイルから表示タイトルを抽出する純関数群。
// 巨大ファイル対策として呼び出し側は先頭 64KB を渡す想定（本モジュールでも slice する）。

const HEAD_LIMIT = 64 * 1024;

// Markdown: frontmatter をスキップして最初の見出し行（# 〜 ######）のテキストを返す。無ければ null
function extractMdTitle(content) {
  if (!content) return null;
  let text = content.slice(0, HEAD_LIMIT).replace(/\r\n/g, '\n');
  // frontmatter（先頭が --- で始まり次の --- 行まで）をスキップ
  if (text.startsWith('---\n')) {
    const end = text.indexOf('\n---', 3);
    if (end !== -1) {
      const nl = text.indexOf('\n', end + 1);
      text = nl === -1 ? '' : text.slice(nl + 1);
    }
  }
  let inFence = false;
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (m) return m[1].trim();
  }
  return null;
}

// HTML: <title> の中身を返す（大小無視・基本エンティティのみデコード）。無ければ null
function extractHtmlTitle(content) {
  if (!content) return null;
  const head = content.slice(0, HEAD_LIMIT);
  const m = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return null;
  const title = m[1]
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return title || null;
}

module.exports = { extractMdTitle, extractHtmlTitle };
