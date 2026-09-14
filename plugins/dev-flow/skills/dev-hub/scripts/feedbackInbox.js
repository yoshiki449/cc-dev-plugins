'use strict';

// feedback-inbox 書き出し（Issue #12 Phase 3）。
// dev-hub のコメントを対象プロジェクトの `.agent/feedback-inbox/<item-id>.json` に
// 書き出し、Claude Code の `/auto-feedback --inbox` で取り込めるようにする。
// 書き込み先は必ず item.path → findProjectRoot → 固定サブパス + item.id（sha1 hex）で
// 導出する（任意パス書き込み API は存在しない）。

const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildExportJson } = require('../public/commentCore');

const INBOX_DIR = path.join('.agent', 'feedback-inbox');
const MAX_ASCEND = 30;

/**
 * filePath から親を遡り、プロジェクトルートを返す。見つからなければ null。
 * 判定は scanDocs.findRepos と同じ規則:
 * - `.git` が存在する（ディレクトリ＝通常リポ、ファイル＝worktree の両対応）
 * - `.git` が無くても `.agent` ディレクトリがある＝傘プロジェクト
 * ただしホームディレクトリ以上はプロジェクトとみなさない（`~/.agent` は
 * グローバル知見置き場であり傘プロジェクトではない）。
 */
function findProjectRoot(filePath, home = os.homedir()) {
  let dir = path.dirname(path.resolve(filePath));
  for (let i = 0; i < MAX_ASCEND; i++) {
    if (dir === home) return null;
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    try {
      if (fs.statSync(path.join(dir, '.agent')).isDirectory()) return dir;
    } catch (_err) {}
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** inbox エントリの書き出し先（<プロジェクトルート>/.agent/feedback-inbox/<item-id>.json） */
function inboxPathFor(projectRoot, itemId) {
  if (!/^[0-9a-f]{16}$/.test(String(itemId))) throw new Error('itemId must be a 16-char sha1 hex');
  return path.join(projectRoot, INBOX_DIR, `${itemId}.json`);
}

/**
 * item のコメント全量を inbox エントリとして書き出す（同一成果物は上書き）。
 * comments は commentStore.readComments() が返す内部形式（id/anchor 付き）を受け取り、
 * buildExportJson で mce 互換形式（id/anchor 除去・startLine 昇順）に変換して格納する。
 * 戻り値: { path, count }
 */
function writeInboxEntry(item, comments) {
  if (!item || !item.id || !item.path) throw new Error('item must have id and path');
  if (!Array.isArray(comments) || comments.length === 0) {
    throw new Error('comments must be a non-empty array');
  }
  const root = findProjectRoot(item.path);
  if (!root) throw new Error('project root not found (no .git / .agent ancestor)');
  const exported = buildExportJson(item.path, comments);
  const entry = {
    version: 1,
    id: item.id,
    type: item.type ?? null,
    project: item.project ?? null,
    file: exported.file,
    created_at: new Date().toISOString(),
    comments: exported.comments,
  };
  const dest = inboxPathFor(root, item.id);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify(entry, null, 2) + '\n', 'utf8');
  return { path: dest, count: entry.comments.length };
}

module.exports = { findProjectRoot, inboxPathFor, writeInboxEntry };
