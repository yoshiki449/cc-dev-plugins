'use strict';

// コメントエンジンの DOM 依存部（mce から移植）。
// - captureSelection: Selection API → ソース行番号解決（commentCore の refineLineRange を使用）
// - ハイライト: CSS Custom Highlight API（DOM を書き換えない）
// - rangeFromAnchor: 保存済み anchor から Range を復元（md ビューの再ハイライト用）
// - renderCommentPanel: コメント一覧（textContent 挿入で XSS 無害化）
// - createIframeBridge: explanation iframe との postMessage 連携（source 比較でなりすまし防止）

/** ノードから祖先方向に最初の [data-source-line] 要素を探す */
function closestSourceLineElement(node, boundary) {
  let element = node instanceof Element ? node : node.parentElement;
  while (element && element !== boundary) {
    if (element.hasAttribute('data-source-line')) return element;
    element = element.parentElement;
  }
  return null;
}

function blockRangeOf(element, fallbackStart, fallbackEnd) {
  if (!element) return { start: fallbackStart, end: fallbackEnd };
  const start = Number(element.getAttribute('data-source-line'));
  const end = Number(element.getAttribute('data-source-line-end') ?? start);
  return { start, end: Number.isFinite(end) ? end : start };
}

/**
 * 現在の Selection から { quote, startLine, endLine, anchor, range } を算出する。
 * 選択がプレビュー外・空の場合は null を返す。
 */
function captureSelection(previewEl, sourceText) {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;

  const range = selection.getRangeAt(0);
  if (!previewEl.contains(range.commonAncestorContainer)) return null;

  const quote = selection.toString();
  const totalLines = sourceText.split('\n').length;

  const startBlockEl = closestSourceLineElement(range.startContainer, previewEl.parentElement);
  const endBlockEl = closestSourceLineElement(range.endContainer, previewEl.parentElement);
  const startBlock = blockRangeOf(startBlockEl, 1, totalLines);
  const endBlock = blockRangeOf(endBlockEl, 1, totalLines);

  const { startLine, endLine } = refineLineRange({
    quote,
    sourceText,
    blockStart: startBlock.start,
    blockStartEnd: startBlock.end,
    blockEnd: endBlock.start,
    blockEndEnd: endBlock.end,
  });

  return {
    quote,
    startLine,
    endLine,
    range: range.cloneRange(),
    anchor: {
      startBlockLine: startBlock.start,
      startOffset: range.startOffset,
      endBlockLine: endBlock.start,
      endOffset: range.endOffset,
    },
  };
}

/** anchor（ブロック行番号＋文字オフセット）から Range を復元する（md ビューの再ハイライト用） */
function rangeFromAnchor(scopeEl, anchor) {
  const startEl = scopeEl.querySelector(`[data-source-line="${anchor.startBlockLine}"]`);
  const endEl = scopeEl.querySelector(`[data-source-line="${anchor.endBlockLine}"]`);
  if (!startEl || !endEl) return null;

  const firstTextNode = (element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    return walker.nextNode();
  };
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

// ---- ハイライト（CSS Custom Highlight API、Chrome 前提） ----

const HUB_HIGHLIGHT_NAME = 'hub-comment';
const HUB_EMPHASIS_NAME = 'hub-comment-active';
const HUB_PENDING_NAME = 'hub-selection-pending';

const hubHighlights = {
  supported: typeof Highlight === 'function' && typeof CSS !== 'undefined' && !!CSS.highlights,
  main: null,
  emphasis: null,
  pending: null,
  ranges: new Map(), // commentId → Range
};

function ensureHighlights() {
  if (!hubHighlights.supported) return false;
  if (!hubHighlights.main) {
    hubHighlights.main = new Highlight();
    hubHighlights.emphasis = new Highlight();
    hubHighlights.pending = new Highlight();
  }
  return true;
}

function addCommentHighlight(commentId, range) {
  if (!ensureHighlights() || !range) return;
  hubHighlights.ranges.set(commentId, range);
  hubHighlights.main.add(range);
  CSS.highlights.set(HUB_HIGHLIGHT_NAME, hubHighlights.main);
}

function removeCommentHighlight(commentId) {
  if (!ensureHighlights()) return;
  clearEmphasizedHighlight();
  const range = hubHighlights.ranges.get(commentId);
  if (!range) return;
  hubHighlights.main.delete(range);
  hubHighlights.ranges.delete(commentId);
}

function clearHighlights() {
  if (!ensureHighlights()) return;
  clearEmphasizedHighlight();
  clearPendingHighlight();
  hubHighlights.main.clear();
  hubHighlights.ranges.clear();
}

function getCommentHighlightRange(commentId) {
  return hubHighlights.ranges.get(commentId) ?? null;
}

function emphasizeCommentHighlight(commentId) {
  if (!ensureHighlights()) return;
  const range = hubHighlights.ranges.get(commentId);
  if (!range) return;
  hubHighlights.emphasis.clear();
  hubHighlights.emphasis.add(range);
  CSS.highlights.set(HUB_EMPHASIS_NAME, hubHighlights.emphasis);
}

function clearEmphasizedHighlight() {
  if (!ensureHighlights()) return;
  hubHighlights.emphasis.clear();
  CSS.highlights.delete(HUB_EMPHASIS_NAME);
}

/**
 * 画面座標 (x, y) を含むハイライト Range のコメント ID を返す（座標ヒットテスト）。
 * プレビュー上のマウス位置からコメントパネル項目を特定するのに使う。
 * iframe（explanation）内のハイライトは Range を親側に持たないためスコープ外
 */
function findCommentIdAtPoint(x, y) {
  for (const [commentId, range] of hubHighlights.ranges) {
    for (const rect of range.getClientRects()) {
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
        return commentId;
      }
    }
  }
  return null;
}

function setPendingHighlight(range) {
  if (!ensureHighlights() || !range) return;
  hubHighlights.pending.clear();
  hubHighlights.pending.add(range);
  CSS.highlights.set(HUB_PENDING_NAME, hubHighlights.pending);
}

function clearPendingHighlight() {
  if (!ensureHighlights()) return;
  hubHighlights.pending.clear();
  CSS.highlights.delete(HUB_PENDING_NAME);
}

// ---- コメントパネル（挿入はすべて textContent = XSS 無害化） ----

const HUB_QUOTE_MAX_LENGTH = 60;

function hubLineBadgeText(comment) {
  if (comment.timestamp != null) return `${comment.timestamp.toFixed(1)}s`;
  if (comment.startLine == null) return '引用';
  return comment.startLine === comment.endLine
    ? `L${comment.startLine}`
    : `L${comment.startLine}-${comment.endLine}`;
}

function buildCommentItem(comment, { onEdit, onDelete, onSelect, onHoverStart, onHoverEnd }) {
  const item = document.createElement('article');
  item.className = 'comment-item';
  item.dataset.commentId = comment.id;

  item.addEventListener('click', (event) => {
    if (event.target instanceof Element && event.target.closest('button')) return;
    onSelect?.(comment);
  });
  item.addEventListener('mouseenter', () => onHoverStart?.(comment));
  item.addEventListener('mouseleave', () => onHoverEnd?.(comment));

  const badge = document.createElement('span');
  badge.className = 'line-badge';
  badge.textContent = hubLineBadgeText(comment);
  item.append(badge);

  if (comment.quote) {
    const quote = document.createElement('p');
    quote.className = 'comment-quote';
    quote.textContent = comment.quote.slice(0, HUB_QUOTE_MAX_LENGTH);
    item.append(quote);
  }

  const body = document.createElement('p');
  body.className = 'comment-body';
  body.textContent = comment.comment;
  item.append(body);

  const actions = document.createElement('div');
  actions.className = 'comment-actions';
  const editButton = document.createElement('button');
  editButton.type = 'button';
  editButton.textContent = '編集';
  editButton.addEventListener('click', () => onEdit(comment));
  actions.append(editButton);
  const deleteButton = document.createElement('button');
  deleteButton.type = 'button';
  deleteButton.textContent = '削除';
  deleteButton.addEventListener('click', () => onDelete(comment));
  actions.append(deleteButton);
  item.append(actions);
  return item;
}

/** コメント一覧を startLine（動画は timestamp）昇順で描画する */
function renderCommentPanel(panelEl, comments, handlers) {
  panelEl.textContent = '';
  const keyOf = (c) => c.timestamp ?? c.startLine ?? 0;
  const sorted = [...comments].sort((a, b) => keyOf(a) - keyOf(b));
  for (const comment of sorted) {
    panelEl.append(buildCommentItem(comment, handlers));
  }
}

// ---- explanation iframe との postMessage 連携 ----

/**
 * iframe とのブリッジを生成する。
 * メッセージ仕様:
 *   iframe → 親: { type: 'selection', quote, startBlockLine, endBlockLine, ..., rect }
 *   親 → iframe: { type: 'highlights', anchors } / { type: 'scroll-to', anchor }
 */
function createIframeBridge(iframe, handlers = {}) {
  const { onSelection } = handlers;
  const onMessage = (event) => {
    // 対象 iframe 以外を source とするメッセージは無視する（なりすまし防止）
    if (event.source !== iframe.contentWindow) return;
    const data = event.data;
    if (!data || typeof data !== 'object' || data.type !== 'selection') return;
    onSelection?.(data);
  };
  window.addEventListener('message', onMessage);
  return {
    sendHighlights(anchors) {
      iframe.contentWindow?.postMessage({ type: 'highlights', anchors }, '*');
    },
    scrollTo(anchor) {
      iframe.contentWindow?.postMessage({ type: 'scroll-to', anchor }, '*');
    },
    dispose() {
      window.removeEventListener('message', onMessage);
    },
  };
}
