// iframe 内注入スクリプト（DESIGN.md 6.2 章）。dev-hub の /doc 配信（explanation）が </body> 直前に注入する（mce から移植）。
// 役割:
//   - テキスト選択の確定（mouseup）を検知し、親へ selection メッセージを送る
//   - 親からの highlights メッセージで anchor から Range を復元しハイライト描画
//   - 親からの scroll-to メッセージで該当ブロックへスクロール
//   - ロード失敗した画像を alt テキスト付きプレースホルダーへ差し替える（欠損アセット対応）
// 対象 HTML 内で動く素のスクリプト（モジュールではない）。
(() => {
  'use strict';

  const HIGHLIGHT_NAME = 'hub-comment';

  // ハイライト色を iframe 文書側に定義する（親のスタイルは iframe に届かない）
  const style = document.createElement('style');
  style.textContent = `::highlight(${HIGHLIGHT_NAME}) { background-color: rgba(255, 212, 0, 0.45); }`;
  document.head.appendChild(style);

  // --- 欠損アセットのフォールバック --------------------------------------------
  // ロード失敗した <img> を「壊れた画像アイコン」の代わりに枠線＋alt テキストの
  // プレースホルダーへ差し替える。data-source-line / data-source-line-end を
  // 引き継ぐことで、プレースホルダー上の選択→コメント付与も機能する。

  function replaceWithPlaceholder(img) {
    if (!img.parentNode) return;
    const placeholder = document.createElement('span');
    placeholder.setAttribute('data-hub-image-placeholder', '');
    placeholder.setAttribute('role', 'img');
    for (const name of ['data-source-line', 'data-source-line-end']) {
      const value = img.getAttribute(name);
      if (value !== null) placeholder.setAttribute(name, value);
    }
    const alt = img.getAttribute('alt') || img.getAttribute('src') || '画像';
    placeholder.textContent = alt;
    placeholder.title = `画像を読み込めませんでした: ${img.getAttribute('src') ?? ''}`;
    placeholder.style.cssText =
      'display:inline-block;border:1px dashed #999;border-radius:4px;' +
      'padding:4px 8px;color:#666;background:#f8f8f8;font-size:0.875em;';
    img.replaceWith(placeholder);
  }

  // error イベントはバブリングしないため capture フェーズで捕捉する
  document.addEventListener(
    'error',
    (event) => {
      const target = event.target;
      if (target instanceof HTMLImageElement) replaceWithPlaceholder(target);
    },
    true,
  );

  // 本スクリプトは </body> 直前で実行されるため、リスナー登録前にロード失敗が
  // 確定した画像（complete かつ naturalWidth === 0）はここで差し替える
  for (const img of Array.from(document.querySelectorAll('img'))) {
    if (img.complete && img.naturalWidth === 0) replaceWithPlaceholder(img);
  }

  /** ノードから祖先方向に最初の [data-source-line] 要素を探す */
  function closestSourceLineElement(node) {
    let element = node instanceof Element ? node : node.parentElement;
    while (element) {
      if (element.hasAttribute('data-source-line')) return element;
      element = element.parentElement;
    }
    return null;
  }

  function lineOf(element, attrName, fallback) {
    const value = element ? Number(element.getAttribute(attrName)) : NaN;
    return Number.isFinite(value) ? value : fallback;
  }

  // --- iframe → 親: 選択確定の通知 -----------------------------------------

  document.addEventListener('mouseup', () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;

    const range = selection.getRangeAt(0);
    const startEl = closestSourceLineElement(range.startContainer);
    const endEl = closestSourceLineElement(range.endContainer);
    const rect = range.getBoundingClientRect();

    window.parent.postMessage(
      {
        type: 'selection',
        quote: selection.toString(),
        startBlockLine: lineOf(startEl, 'data-source-line', 1),
        endBlockLine: lineOf(endEl, 'data-source-line', 1),
        // 段階2（行精緻化）用の補助情報（DESIGN.md 6.3 章）
        startBlockLineEnd: lineOf(startEl, 'data-source-line-end', lineOf(startEl, 'data-source-line', 1)),
        endBlockLineEnd: lineOf(endEl, 'data-source-line-end', lineOf(endEl, 'data-source-line', 1)),
        startOffset: range.startOffset,
        endOffset: range.endOffset,
        rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
      },
      '*',
    );
  });

  // --- 親 → iframe: ハイライト描画・スクロール -------------------------------

  function blockElementOf(line) {
    return document.querySelector(`[data-source-line="${line}"]`);
  }

  function firstTextNode(element) {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    return walker.nextNode();
  }

  /** anchor（ブロック行番号＋文字オフセット）から Range を復元する */
  function rangeFromAnchor(anchor) {
    const startEl = blockElementOf(anchor.startBlockLine);
    const endEl = blockElementOf(anchor.endBlockLine);
    if (!startEl || !endEl) return null;

    const range = document.createRange();
    const startText = firstTextNode(startEl);
    const endText = firstTextNode(endEl);
    if (!startText || !endText) {
      range.selectNodeContents(startEl);
      return range;
    }
    range.setStart(startText, Math.min(anchor.startOffset ?? 0, startText.data.length));
    range.setEnd(endText, Math.min(anchor.endOffset ?? endText.data.length, endText.data.length));
    if (range.collapsed) range.selectNodeContents(startEl);
    return range;
  }

  /**
   * quote テキストの本文検索から Range を復元する（data-source-line 注釈が無い
   * 生成 HTML［explain-diff 等］向けのフォールバック）。全テキストノードを連結した
   * 文字列中で quote の最初の出現位置を探し、ノード＋オフセットに逆引きする。
   * 複数ブロックにまたがる quote は改行差で一致しないことがあるため、
   * 失敗時は quote の先頭行だけでも試す。
   */
  function rangeFromQuote(quote) {
    if (!quote) return null;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let full = '';
    let n;
    while ((n = walker.nextNode())) {
      nodes.push({ node: n, start: full.length });
      full += n.data;
    }
    const locate = (pos) => {
      for (let i = nodes.length - 1; i >= 0; i -= 1) {
        const { node, start } = nodes[i];
        if (pos >= start && pos <= start + node.data.length) {
          return { node, offset: pos - start };
        }
      }
      return null;
    };
    for (const needle of [quote, quote.split('\n')[0].trim()]) {
      if (!needle) continue;
      const idx = full.indexOf(needle);
      if (idx === -1) continue;
      const s = locate(idx);
      const e = locate(idx + needle.length);
      if (!s || !e) continue;
      const range = document.createRange();
      range.setStart(s.node, s.offset);
      range.setEnd(e.node, e.offset);
      if (!range.collapsed) return range;
    }
    return null;
  }

  function renderHighlights(anchors) {
    if (typeof Highlight !== 'function' || !CSS.highlights) return;
    const highlight = new Highlight();
    for (const anchor of anchors) {
      try {
        const range = rangeFromAnchor(anchor) ?? rangeFromQuote(anchor.quote);
        if (range) highlight.add(range);
      } catch {
        // Range を復元できない anchor はスキップ（ハイライトなしでもコメントは有効）
      }
    }
    CSS.highlights.set(HIGHLIGHT_NAME, highlight);
  }

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'highlights') {
      renderHighlights(Array.isArray(data.anchors) ? data.anchors : []);
    } else if (data.type === 'scroll-to' && data.anchor) {
      const el =
        blockElementOf(data.anchor.startBlockLine) ??
        rangeFromQuote(data.anchor.quote)?.startContainer?.parentElement;
      el?.scrollIntoView({ block: 'center' });
    }
  });
})();
