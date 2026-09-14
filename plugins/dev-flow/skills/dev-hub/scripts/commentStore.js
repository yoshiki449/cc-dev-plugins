'use strict';

// コメントのサイドカー永続化（write-through）。
// サイドカーは対象ファイルの隣の `<ファイル名>.comments.json`（mce 慣行）。
// スキーマは mce 互換（file / comments[].quote,startLine,endLine,comment）に
// 内部フィールド（id / anchor / timestamp / screenshot）を足した上位互換。
// 書き込み先は必ず item.path から導出する（任意パス書き込み API は存在しない）。

const fs = require('fs');
const path = require('path');

const MAX_COMMENTS = 500;
const MAX_TEXT = 10000;

function sidecarPathFor(itemPath) {
  return `${itemPath}.comments.json`;
}

/** サイドカーを読む。無ければ空。壊れた JSON は空扱い（エラーにしない） */
function readComments(itemPath) {
  try {
    const raw = fs.readFileSync(sidecarPathFor(itemPath), 'utf8');
    const data = JSON.parse(raw);
    if (data && Array.isArray(data.comments)) {
      return { file: itemPath, comments: data.comments };
    }
  } catch (_err) {}
  return { file: itemPath, comments: [] };
}

/**
 * コメント配列のバリデーション（型・サイズ・許可フィールドのみ）。
 * 不正なら Error を投げる。
 */
function validateComments(comments) {
  if (!Array.isArray(comments)) throw new Error('comments must be an array');
  if (comments.length > MAX_COMMENTS) throw new Error(`too many comments (max ${MAX_COMMENTS})`);
  return comments.map((c, idx) => {
    if (!c || typeof c !== 'object') throw new Error(`comments[${idx}] must be an object`);
    if (typeof c.comment !== 'string' || c.comment.length === 0 || c.comment.length > MAX_TEXT) {
      throw new Error(`comments[${idx}].comment must be a non-empty string`);
    }
    if (c.quote != null && (typeof c.quote !== 'string' || c.quote.length > MAX_TEXT)) {
      throw new Error(`comments[${idx}].quote must be a string`);
    }
    for (const key of ['startLine', 'endLine', 'timestamp']) {
      if (c[key] != null && (typeof c[key] !== 'number' || !Number.isFinite(c[key]))) {
        throw new Error(`comments[${idx}].${key} must be a number`);
      }
    }
    if (c.id != null && typeof c.id !== 'string') throw new Error(`comments[${idx}].id must be a string`);
    if (c.screenshot != null && typeof c.screenshot !== 'string') {
      throw new Error(`comments[${idx}].screenshot must be a string`);
    }
    if (c.anchor != null && typeof c.anchor !== 'object') {
      throw new Error(`comments[${idx}].anchor must be an object`);
    }
    // 許可フィールドのみ透過（未知フィールドは落とす）
    const out = { id: c.id ?? null, quote: c.quote ?? '', startLine: c.startLine ?? null, endLine: c.endLine ?? null, comment: c.comment };
    if (c.anchor != null) out.anchor = c.anchor;
    if (c.timestamp != null) out.timestamp = c.timestamp;
    if (c.screenshot != null) out.screenshot = c.screenshot;
    return out;
  });
}

/** コメント全量をサイドカーへ書き込む（write-through）。0 件ならサイドカーを削除する */
function writeComments(itemPath, comments) {
  const validated = validateComments(comments);
  const sidecar = sidecarPathFor(itemPath);
  if (validated.length === 0) {
    try {
      fs.unlinkSync(sidecar);
    } catch (_err) {}
    return { file: itemPath, comments: [] };
  }
  const payload = {
    file: itemPath,
    updated_at: new Date().toISOString(),
    comments: validated,
  };
  fs.writeFileSync(sidecar, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return payload;
}

/** 動画フレーム PNG の保存先（t はミリ秒・整数のみ許可） */
function framePathFor(itemPath, t) {
  if (!Number.isInteger(t) || t < 0) throw new Error('t must be a non-negative integer (ms)');
  return `${itemPath}.frame-${t}.png`;
}

module.exports = { sidecarPathFor, readComments, writeComments, validateComments, framePathFor };
