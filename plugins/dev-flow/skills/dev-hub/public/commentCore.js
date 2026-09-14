'use strict';

// コメントエンジンの純関数部（mce から移植、DOM 非依存・node:test 対象）。
// - refineLineRange: 選択 quote とブロック行範囲からソース行を精緻化（失敗時はブロック先頭行 = F6b）
// - buildExportJson: 内部コメント（id/anchor 付き）→ mce 互換のエクスポート JSON
// - buildPromptText / buildVideoPromptText: Claude Code へ貼る修正指示プロンプト

/** 空白正規化: 連続空白を 1 個にまとめ、前後をトリムする */
function hubNormalizeText(text) {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * needle（正規化済みテキスト）が from〜to 行（1 始まり・両端含む）の中で
 * ちょうど 1 行にだけ含まれる場合、その行番号を返す。0 件・複数件は null。
 */
function hubFindUniqueLine(lines, needle, from, to) {
  if (!needle) return null;
  const hits = [];
  const last = Math.min(to, lines.length);
  for (let lineNo = Math.max(from, 1); lineNo <= last; lineNo += 1) {
    if (hubNormalizeText(lines[lineNo - 1]).includes(needle)) {
      hits.push(lineNo);
    }
  }
  return hits.length === 1 ? hits[0] : null;
}

/**
 * 選択 quote とブロックのソース行範囲から、開始行・終了行を精緻化する。
 * 精緻化できない場合はブロック先頭行にフォールバックする（F6b）。
 */
function refineLineRange({ quote, sourceText, blockStart, blockStartEnd, blockEnd, blockEndEnd }) {
  const lines = sourceText.split('\n');
  const quoteLines = quote.split('\n');
  const firstQuoteLine = hubNormalizeText(quoteLines[0]);
  const lastQuoteLine = hubNormalizeText(quoteLines[quoteLines.length - 1]);

  const startLine = hubFindUniqueLine(lines, firstQuoteLine, blockStart, blockStartEnd) ?? blockStart;

  // 検索開始位置を startLine 以降に限定（ブロック内重複への対応）
  let endLine =
    hubFindUniqueLine(lines, lastQuoteLine, Math.max(startLine, blockEnd), blockEndEnd) ?? blockEnd;

  if (endLine < startLine) endLine = startLine;
  return { startLine, endLine };
}

// ---- エクスポート整形（mce 互換スキーマ） ----

/** 内部コメント配列 → エクスポート JSON（id / anchor を除去、startLine 昇順） */
function buildExportJson(filePath, comments) {
  const sorted = [...comments].sort((a, b) => (a.startLine ?? 0) - (b.startLine ?? 0));
  return {
    file: filePath,
    comments: sorted.map((c) => {
      const out = { quote: c.quote, startLine: c.startLine, endLine: c.endLine, comment: c.comment };
      if (c.timestamp != null) out.timestamp = c.timestamp;
      if (c.screenshot != null) out.screenshot = c.screenshot;
      return out;
    }),
  };
}

// ---- Claude Code 向けプロンプト ----

const HUB_PROMPT_PREAMBLE = `以下のレビューコメントに従って対象ファイルを修正してください。

- file はレビュー対象ファイルの絶対パスです
- 各コメントの quote / startLine / endLine が指摘箇所（引用とソースファイル上の行番号）です
  （startLine が null のコメントは quote で該当箇所を特定してください）
- 各コメントの comment が修正指示です
- 修正後、各指摘にどう対応したかを簡潔に報告してください`;

const HUB_VIDEO_PROMPT_PREAMBLE = `以下は E2E テスト動画へのレビューコメントです。指摘に従って対象機能を修正してください。

- file はレビュー対象の動画（テスト録画）の絶対パスです
- 各コメントの timestamp は動画内の秒数、screenshot はコメント時点のフレーム画像（絶対パス）です
- screenshot を Read で開いて指摘箇所の画面を確認してから対応してください
- 各コメントの comment が修正指示です
- 修正後、各指摘にどう対応したかを簡潔に報告してください`;

/** 出力 JSON を修正指示プロンプト（前文＋\`\`\`json フェンス）に変換する */
function buildPromptText(exportJson) {
  const json = JSON.stringify(exportJson, null, 2);
  return `${HUB_PROMPT_PREAMBLE}\n\n\`\`\`json\n${json}\n\`\`\`\n`;
}

/** 動画コメント用のプロンプト */
function buildVideoPromptText(exportJson) {
  const json = JSON.stringify(exportJson, null, 2);
  return `${HUB_VIDEO_PROMPT_PREAMBLE}\n\n\`\`\`json\n${json}\n\`\`\`\n`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { refineLineRange, buildExportJson, buildPromptText, buildVideoPromptText };
}
