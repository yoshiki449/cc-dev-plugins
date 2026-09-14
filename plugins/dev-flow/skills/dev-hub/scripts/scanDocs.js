'use strict';

// ドキュメント成果物と実行マニフェストのスキャン。
// ドキュメント保管規約（/doc-standard）のパスをそのままスキャン仕様とする:
//   docs/**/*.md               → type 'doc'（設計文書）
//   docs/plans/**/*.md         → type 'plan'（採用プラン）
//   .agent/explanations/*.html → type 'explanation'（explain-diff 理解ドキュメント）
//   .agent/hub-runs/*.json     → 実行マニフェスト（実行履歴ビューの元データ）
// 加えてグローバル未取り込み分（~/.claude/explanations, ~/.claude/plans）を明示スキャンする。

const fs = require('fs');
const path = require('path');

const { extractMdTitle, extractHtmlTitle } = require('./titleResolver');
const { inferWorktree } = require('./scan');

const GLOBAL_PROJECT = '(グローバル)';
const VIDEO_EXTS = new Set(['.webm', '.mp4', '.mov', '.mkv']);

// .agent 配下のレポート類。
// 正式な置き場所は .agent/reports/（配下の md は全てレポート）。
// 旧形式（.agent/ 直下の qa-report-* 等）と evidence 内の findings は互換スキャンする
const AGENT_REPORT_RE = /^(qa-report|security-review|security-check|triage)[-_.].*\.md$/i;
const EVIDENCE_REPORT_RE = /^(findings-.*|qa-brief.*|qa-report.*)\.md$/i;

// リポジトリルートからの相対パスで成果物種別を判定する純関数
function classifyDocPath(relPath) {
  const rel = relPath.split(path.sep).join('/');
  const lower = rel.toLowerCase();
  if (lower.startsWith('docs/plans/') && lower.endsWith('.md')) return 'plan';
  if (lower.startsWith('docs/') && lower.endsWith('.md')) return 'doc';
  if (lower.startsWith('.agent/explanations/') && /\.html?$/.test(lower)) return 'explanation';
  if (lower.startsWith('.agent/test-ledger/') && lower.endsWith('.md')) return 'ledger';
  if (lower.startsWith('.agent/reports/') && lower.endsWith('.md')) return 'report';
  const base = rel.split('/').pop();
  if (rel.startsWith('.agent/evidence/') && EVIDENCE_REPORT_RE.test(base)) return 'report';
  if (/^\.agent\/[^/]+$/.test(rel) && AGENT_REPORT_RE.test(base)) return 'report';
  return null;
}

// マニフェスト記載の成果物の種別判定（規約パス優先 → 拡張子フォールバック）
function classifyRunArtifact(relPath) {
  const byRule = classifyDocPath(relPath);
  if (byRule) return byRule;
  const rel = relPath.split(path.sep).join('/');
  const ext = path.extname(relPath).toLowerCase();
  if (rel.startsWith('.agent/') && ext === '.md') return 'report';
  if (ext === '.md') return 'doc';
  if (ext === '.html' || ext === '.htm') return 'explanation';
  if (VIDEO_EXTS.has(ext)) return 'video';
  return null;
}

// プロジェクトルートの列挙。
// - .git を持つディレクトリ = git リポジトリ（それ以上は降りない。doc-standard の方式）
// - .git は無いが .agent/ を持つディレクトリ = 「傘プロジェクト」
//   （例: hrms/ が配下に backend/frontend の git リポを持ちつつ、傘自身の docs/ と
//    .agent/ に QA レポート等を持つ構成）。傘として登録した上で配下の探索も続ける
function findRepos(root, config, results, depth) {
  if (depth > config.maxDepth) return;
  let hasGit = false;
  try {
    hasGit = fs.existsSync(path.join(root, '.git'));
  } catch (_err) {
    return;
  }
  if (hasGit) {
    results.push(root);
    return;
  }
  if (fs.existsSync(path.join(root, '.agent'))) {
    results.push(root);
  }
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (_err) {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.isSymbolicLink()) continue;
    if (config.excludeDirs.has(entry.name)) continue;
    findRepos(path.join(root, entry.name), config, results, depth + 1);
  }
}

// 全リポジトリ（<repo>/.claude/worktrees/* のネスト worktree 含む）を1回ずつ訪問する。
// worktree には親リポのプロジェクト名を引き継ぐ。bind mount / symlink の重複は realpath で排除
function forEachRepo(config, cb) {
  const roots = [];
  for (const root of config.scanRoots) {
    if (!fs.existsSync(root)) continue;
    findRepos(root, config, roots, 0);
  }
  const seen = new Set();
  const visit = (repoRoot, projectOverride) => {
    // bind mount / symlink で同一リポが複数パスから見えるため dev:ino で重複排除
    // （realpath は bind mount を解決できない）
    let key = repoRoot;
    try {
      const st = fs.statSync(repoRoot);
      key = `${st.dev}:${st.ino}`;
    } catch (_err) {}
    if (seen.has(key)) return;
    seen.add(key);
    const project = projectOverride || path.basename(repoRoot);
    cb(repoRoot, project);
    const wtBase = path.join(repoRoot, '.claude', 'worktrees');
    let wtEntries = [];
    try {
      wtEntries = fs.readdirSync(wtBase, { withFileTypes: true });
    } catch (_err) {}
    for (const entry of wtEntries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const wtRoot = path.join(wtBase, entry.name);
      if (fs.existsSync(path.join(wtRoot, '.git'))) visit(wtRoot, project);
    }
  };
  for (const repo of roots) visit(repo, null);
}

function makeItem(type, filePath, project) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (_err) {
    return null;
  }
  if (!stat.isFile() || stat.size === 0) return null;

  let writable = false;
  try {
    fs.accessSync(filePath, fs.constants.W_OK);
    writable = true;
  } catch (_err) {}

  const base = {
    type,
    path: filePath,
    name: path.basename(filePath),
    project,
    worktree: project === GLOBAL_PROJECT ? null : inferWorktree(filePath),
    size: stat.size,
    mtime: stat.mtimeMs,
    ino: `${stat.dev}:${stat.ino}`,
    writable,
  };

  if (type === 'video') {
    // マニフェスト経由の動画は Playwright レポートによる enrich なしの素朴な item
    const title = path.basename(filePath);
    return { ...base, title, test: title, category: 'other', scenarioNumber: null, matched: false, retry: 0 };
  }

  let title = null;
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    title = type === 'explanation' ? extractHtmlTitle(content) : extractMdTitle(content);
  } catch (_err) {}
  if (!title) title = path.basename(filePath).replace(/\.(md|html?)$/i, '');
  return { ...base, title };
}

// dir 配下の対象ファイルを再帰収集（symlink・除外ディレクトリはスキップ）
function walkFiles(dir, maxDepth, depth, out) {
  if (depth > maxDepth) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_err) {
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      walkFiles(full, maxDepth, depth + 1, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
}

// リポジトリ1件の規約パスのスキャン
function scanRepoDocs(repoRoot, project, items) {
  const docsDir = path.join(repoRoot, 'docs');
  const docFiles = [];
  walkFiles(docsDir, 6, 0, docFiles);
  for (const file of docFiles) {
    const type = classifyDocPath(path.relative(repoRoot, file));
    if (!type) continue;
    const item = makeItem(type, file, project);
    if (item) items.push(item);
  }

  const explDir = path.join(repoRoot, '.agent', 'explanations');
  const explFiles = [];
  walkFiles(explDir, 2, 0, explFiles);
  for (const file of explFiles) {
    if (!/\.html?$/i.test(file)) continue;
    const item = makeItem('explanation', file, project);
    if (item) items.push(item);
  }

  // .agent/test-ledger/**（テストケース台帳。dev-test-ledger が出力する）
  const ledgerFiles = [];
  walkFiles(path.join(repoRoot, '.agent', 'test-ledger'), 2, 0, ledgerFiles);
  for (const file of ledgerFiles) {
    if (!/\.md$/i.test(file)) continue;
    const item = makeItem('ledger', file, project);
    if (item) items.push(item);
  }

  // .agent/reports/**（レポートの正式な置き場所。配下の md は全てレポート）
  const reportFiles = [];
  walkFiles(path.join(repoRoot, '.agent', 'reports'), 3, 0, reportFiles);
  for (const file of reportFiles) {
    if (!/\.md$/i.test(file)) continue;
    const item = makeItem('report', file, project);
    if (item) items.push(item);
  }

  // 旧形式互換: .agent 直下のレポート類（qa-report / security-review / security-check / triage）
  let agentEntries = [];
  try {
    agentEntries = fs.readdirSync(path.join(repoRoot, '.agent'), { withFileTypes: true });
  } catch (_err) {}
  for (const entry of agentEntries) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    if (!AGENT_REPORT_RE.test(entry.name)) continue;
    const item = makeItem('report', path.join(repoRoot, '.agent', entry.name), project);
    if (item) items.push(item);
  }

  // .agent/evidence/**（QA 証跡: findings-* / qa-brief / qa-report）
  const evidenceFiles = [];
  walkFiles(path.join(repoRoot, '.agent', 'evidence'), 4, 0, evidenceFiles);
  for (const file of evidenceFiles) {
    if (!EVIDENCE_REPORT_RE.test(path.basename(file))) continue;
    const item = makeItem('report', file, project);
    if (item) items.push(item);
  }
}

// リポジトリ1件の実行マニフェスト（.agent/hub-runs/*.json）の読み込み
function scanRepoRuns(repoRoot, project, runs, extraItems) {
  const runsDir = path.join(repoRoot, '.agent', 'hub-runs');
  let entries = [];
  try {
    entries = fs.readdirSync(runsDir, { withFileTypes: true });
  } catch (_err) {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const file = path.join(runsDir, entry.name);
    let manifest;
    let stat;
    try {
      manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
      stat = fs.statSync(file);
    } catch (_err) {
      continue;
    }
    if (!manifest || !Array.isArray(manifest.artifacts)) continue;
    const runId = manifest.run_id || entry.name.replace(/\.json$/, '');
    const artifactPaths = [];
    for (const a of manifest.artifacts) {
      if (!a || typeof a.path !== 'string') continue;
      const rel = a.path;
      if (rel.split('/').includes('..')) continue; // リポ外参照は無視
      const abs = path.join(repoRoot, ...rel.split('/'));
      const type = classifyRunArtifact(rel);
      if (!type) continue;
      const item = makeItem(type, abs, project);
      if (!item) continue; // 消えたファイルはスキップ
      extraItems.push(item);
      artifactPaths.push(abs);
    }
    runs.push({
      manifestPath: file,
      runId,
      label: manifest.label || runId,
      flow: manifest.flow || null,
      issue: Number.isInteger(manifest.issue) ? manifest.issue : null,
      project,
      worktree: inferWorktree(path.join(repoRoot, 'x')),
      mtime: stat.mtimeMs,
      artifactPaths,
    });
  }
}

// グローバル未取り込み分（リポジトリ外）。.md → plan、.html → explanation
function scanGlobalDirs(config, items) {
  for (const dir of config.globalDirs || []) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_err) {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      let type = null;
      if (/\.md$/i.test(entry.name)) type = 'plan';
      else if (/\.html?$/i.test(entry.name)) type = 'explanation';
      if (!type) continue;
      const item = makeItem(type, full, GLOBAL_PROJECT);
      if (item) items.push(item);
    }
  }
}

// 規約パスの成果物＋実行マニフェストを一括スキャン。
// items にはマニフェスト記載でスキャン仕様外のファイル（.agent/ 配下の QA レポート等）も含まれる。
// 同一パスの重複排除は呼び出し側（server の rescan）が行う
function scanHub(config) {
  const items = [];
  const runs = [];
  const extraItems = [];
  forEachRepo(config, (repoRoot, project) => {
    scanRepoDocs(repoRoot, project, items);
    scanRepoRuns(repoRoot, project, runs, extraItems);
  });
  scanGlobalDirs(config, items);
  items.push(...extraItems);
  items.sort((a, b) => b.mtime - a.mtime);
  runs.sort((a, b) => b.mtime - a.mtime);
  return { items, runs };
}

// 互換: ドキュメントのみ（テスト・旧呼び出し用）
function scanDocs(config) {
  return scanHub(config).items;
}

module.exports = { scanHub, scanDocs, classifyDocPath, classifyRunArtifact, findRepos, GLOBAL_PROJECT };
