'use strict';

// 簡易 Markdown レンダラ（ゼロ依存・XSS セーフ・ソース行番号注釈付き）。
// 方針: 全テキストを先に escapeHtml してから md 変換する。HTML になるのは
// 本レンダラが自前で出力するタグだけで、入力由来のタグは常に実体参照のまま残る。
// 各ブロック要素に data-source-line / data-source-line-end（1始まり）を付与し、
// mce 由来のコメントエンジン（選択→行番号解決）がそのまま動くようにする。
// escapeHtml は行境界を変えないため、split 後の添字+1 がソース行番号に一致する。

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// data-source-line 属性文字列（1始まり）
function lineAttrs(start, end) {
  return ` data-source-line="${start}" data-source-line-end="${end == null ? start : end}"`;
}

// インライン変換。入力はエスケープ済み文字列
function renderInline(text) {
  const codeSpans = [];
  // inline code を退避（内部に他の変換をかけない）
  let out = text.replace(/`([^`\n]+)`/g, (_m, code) => {
    codeSpans.push(code);
    return `\u0000${codeSpans.length - 1}\u0000`;
  });
  // 画像は alt テキストのみ表示（ローカル相対パスは配信できない）
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]*)\)/g, (_m, alt) => (alt ? `[画像: ${alt}]` : '[画像]'));
  // リンク: 安全なスキームのみ <a> 化。それ以外はテキストのまま
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, href) => {
    if (/^(https?:|mailto:|#)/i.test(href)) {
      return `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    }
    return m;
  });
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  out = out.replace(/(^|\s)_([^_\n]+)_(?=\s|$)/g, '$1<em>$2</em>');
  out = out.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  out = out.replace(/\u0000(\d+)\u0000/g, (_m, i) => `<code>${codeSpans[Number(i)]}</code>`);
  return out;
}

function isTableSeparator(line) {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line);
}

function splitTableRow(line) {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|')) row = row.slice(0, -1);
  return row.split('|').map((c) => c.trim());
}

function renderMarkdown(src) {
  if (src == null) return '';
  const lines = escapeHtml(String(src).replace(/\r\n/g, '\n')).split('\n');
  const html = [];
  const listStack = []; // {tag:'ul'|'ol', indent:number}
  let inCode = false;
  let codeOpenIdx = -1; // <pre> のパッチ位置（閉じフェンス到達時に行範囲を確定する）
  let codeStartLine = 0;
  let inQuote = false;
  let quoteOpenIdx = -1;
  let quoteStartLine = 0;
  let quoteEndLine = 0;
  let paragraph = [];
  let paraStartLine = 0;
  let paraEndLine = 0;

  function closeParagraph() {
    if (paragraph.length) {
      html.push(`<p${lineAttrs(paraStartLine, paraEndLine)}>${renderInline(paragraph.join(' '))}</p>`);
      paragraph = [];
    }
  }
  function closeLists(toIndent) {
    while (listStack.length && (toIndent == null || listStack[listStack.length - 1].indent >= toIndent)) {
      html.push(`</${listStack.pop().tag}>`);
    }
  }
  function closeQuote() {
    if (inQuote) {
      html[quoteOpenIdx] = `<blockquote${lineAttrs(quoteStartLine, quoteEndLine)}>`;
      html.push('</blockquote>');
      inQuote = false;
    }
  }
  function closeCode(endLine) {
    html[codeOpenIdx] = `<pre${lineAttrs(codeStartLine, endLine)}><code>`;
    html.push('</code></pre>');
    inCode = false;
  }
  function closeBlocks() {
    closeParagraph();
    closeLists(null);
    closeQuote();
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const lineNo = i + 1;

    // フェンスコードブロック
    if (/^\s*(```|~~~)/.test(line)) {
      if (inCode) {
        closeCode(lineNo);
      } else {
        closeBlocks();
        codeOpenIdx = html.length;
        codeStartLine = lineNo;
        html.push('<pre><code>'); // closeCode で行範囲付きにパッチされる
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      html.push(line);
      continue;
    }

    // 空行
    if (/^\s*$/.test(line)) {
      closeBlocks();
      continue;
    }

    // 見出し
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      closeBlocks();
      const level = heading[1].length;
      html.push(`<h${level}${lineAttrs(lineNo)}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }

    // 水平線
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      closeBlocks();
      html.push(`<hr${lineAttrs(lineNo)}>`);
      continue;
    }

    // テーブル（次行が separator のときだけ）
    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      closeBlocks();
      const tableOpenIdx = html.length;
      const tableStartLine = lineNo;
      let tableEndLine = lineNo + 1;
      const headers = splitTableRow(line);
      html.push('<table>'); // ループ後に行範囲付きにパッチされる
      html.push(`<thead><tr${lineAttrs(lineNo)}>`);
      for (const h of headers) html.push(`<th>${renderInline(h)}</th>`);
      html.push('</tr></thead><tbody>');
      i += 1; // separator をスキップ
      while (i + 1 < lines.length && lines[i + 1].includes('|') && lines[i + 1].trim() !== '') {
        i += 1;
        tableEndLine = i + 1;
        const cells = splitTableRow(lines[i]);
        html.push(`<tr${lineAttrs(i + 1)}>`);
        for (let c = 0; c < headers.length; c += 1) {
          html.push(`<td>${renderInline(cells[c] || '')}</td>`);
        }
        html.push('</tr>');
      }
      html.push('</tbody></table>');
      html[tableOpenIdx] = `<table${lineAttrs(tableStartLine, tableEndLine)}>`;
      continue;
    }

    // 引用（1レベル）
    const quote = line.match(/^\s*&gt;\s?(.*)$/);
    if (quote) {
      closeParagraph();
      closeLists(null);
      if (!inQuote) {
        quoteOpenIdx = html.length;
        quoteStartLine = lineNo;
        html.push('<blockquote>'); // closeQuote で行範囲付きにパッチされる
        inQuote = true;
      }
      quoteEndLine = lineNo;
      html.push(`<p${lineAttrs(lineNo)}>${renderInline(quote[1])}</p>`);
      continue;
    }
    closeQuote();

    // リスト（ネスト対応、2スペース単位）
    const list = line.match(/^(\s*)([-*+]|\d+\.)\s+(.+)$/);
    if (list) {
      closeParagraph();
      const indent = list[1].length;
      const tag = /^\d+\.$/.test(list[2]) ? 'ol' : 'ul';
      const top = listStack[listStack.length - 1];
      if (!top || indent > top.indent) {
        html.push(`<${tag}>`);
        listStack.push({ tag, indent });
      } else {
        while (listStack.length > 1 && listStack[listStack.length - 1].indent > indent) {
          html.push(`</${listStack.pop().tag}>`);
        }
        const cur = listStack[listStack.length - 1];
        if (cur && cur.tag !== tag && cur.indent === indent) {
          html.push(`</${listStack.pop().tag}>`);
          html.push(`<${tag}>`);
          listStack.push({ tag, indent });
        }
      }
      // チェックボックス
      const item = list[3]
        .replace(/^\[ \]\s+/, '<span class="md-checkbox">☐</span> ')
        .replace(/^\[[xX]\]\s+/, '<span class="md-checkbox">☑</span> ');
      html.push(`<li${lineAttrs(lineNo)}>${renderInline(item)}</li>`);
      continue;
    }
    closeLists(null);

    // 段落
    if (paragraph.length === 0) paraStartLine = lineNo;
    paraEndLine = lineNo;
    paragraph.push(line.trim());
  }

  if (inCode) closeCode(lines.length);
  closeBlocks();
  return html.join('\n');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { renderMarkdown, escapeHtml };
}
