'use strict';

const fs = require('fs');
const path = require('path');

const { enrichVideo, resetCache: resetReportCache } = require('./reportReader');

function findGitRoot(filePath) {
  let dir = path.dirname(filePath);
  for (let i = 0; i < 30; i += 1) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function inferProjectName(filePath) {
  const root = findGitRoot(filePath);
  if (root) return path.basename(root);
  return path.basename(path.dirname(filePath));
}

function inferWorktree(filePath) {
  const segments = filePath.split(path.sep);
  const wtIdx = segments.lastIndexOf('worktrees');
  if (wtIdx !== -1 && wtIdx + 1 < segments.length) {
    return segments[wtIdx + 1];
  }
  return null;
}

function inferTestDirName(filePath) {
  const segments = filePath.split(path.sep);
  const trIdx = segments.lastIndexOf('test-results');
  if (trIdx !== -1 && trIdx + 1 < segments.length) {
    return segments[trIdx + 1];
  }
  const prIdx = segments.lastIndexOf('playwright-report');
  if (prIdx !== -1 && prIdx + 1 < segments.length) {
    return segments.slice(prIdx + 1, -1).join('/') || path.basename(filePath);
  }
  return path.basename(path.dirname(filePath));
}

function prettifyFallback(parsed, fallback) {
  if (!parsed) return fallback;
  const parts = [];
  if (parsed.fileSlug) parts.push(parsed.fileSlug);
  if (parsed.titleTail) parts.push(parsed.titleTail);
  if (parts.length === 0) return fallback;
  return parts.join(' › ');
}

function buildTitle(match, parsed, fallback) {
  if (match) {
    const describe = match.describe && match.describe.length ? match.describe.join(' › ') : '';
    return describe ? `${describe} › ${match.title}` : match.title;
  }
  return prettifyFallback(parsed, fallback);
}

function inferCategory(specFile, dirName) {
  const src = `${specFile || ''} ${dirName || ''}`.toLowerCase();
  if (src.includes('user-stories') || src.includes('user_stories') || src.includes('userstories')) {
    return 'user-stories';
  }
  if (src.includes('functional')) return 'functional';
  return 'other';
}

function extractScenarioNumber(title) {
  if (!title) return null;
  const m = title.match(/シナリオ\s*(\d+)/);
  return m ? Number.parseInt(m[1], 10) : null;
}

function scanDir(root, config, results, depth) {
  if (depth > config.maxDepth) return;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (_err) {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.isDirectory()) {
      if (config.excludeDirs.has(entry.name)) continue;
    }
    if (config.excludeDirs.has(entry.name)) continue;

    const full = path.join(root, entry.name);

    if (entry.isSymbolicLink()) continue;

    if (entry.isDirectory()) {
      scanDir(full, config, results, depth + 1);
      continue;
    }
    if (!entry.isFile()) continue;

    const ext = path.extname(entry.name).toLowerCase();
    if (!config.videoExtensions.has(ext)) continue;

    let stat;
    try {
      stat = fs.statSync(full);
    } catch (_err) {
      continue;
    }
    if (stat.size < 1024) continue;

    let writable = false;
    try {
      fs.accessSync(full, fs.constants.W_OK);
      writable = true;
    } catch (_err) {}

    const dirName = inferTestDirName(full);
    const enriched = enrichVideo(full, dirName);
    const title = buildTitle(enriched.match, enriched.parsed, dirName);
    const specFile = enriched.match ? enriched.match.file : null;
    const category = inferCategory(specFile, dirName);

    results.push({
      type: 'video',
      title,
      path: full,
      ino: `${stat.dev}:${stat.ino}`,
      name: entry.name,
      project: inferProjectName(full),
      worktree: inferWorktree(full),
      test: title,
      dirName,
      category,
      scenarioNumber: extractScenarioNumber(title),
      specFile,
      specLine: enriched.match ? enriched.match.line : null,
      describe: enriched.match ? enriched.match.describe : null,
      browser: enriched.match ? enriched.match.browser : enriched.parsed && enriched.parsed.browser,
      retry: enriched.parsed ? enriched.parsed.retry || 0 : 0,
      outcome: enriched.match ? enriched.match.outcome : null,
      matched: !!enriched.match,
      size: stat.size,
      mtime: stat.mtimeMs,
      writable,
    });
  }
}

function scanVideos(config) {
  resetReportCache();
  const results = [];
  for (const root of config.scanRoots) {
    if (!fs.existsSync(root)) continue;
    scanDir(root, config, results, 0);
  }
  results.sort((a, b) => b.mtime - a.mtime);
  return results;
}

module.exports = { scanVideos, findGitRoot, inferProjectName, inferWorktree };
