'use strict';

const fs = require('fs');
const path = require('path');

const { readZipEntries, extractEntry } = require('./zipReader');
const jsonReportReader = require('./jsonReportReader');

const reportCache = new Map();

function findReportDir(videoPath) {
  let dir = path.dirname(videoPath);
  for (let i = 0; i < 10; i += 1) {
    const candidate = path.join(dir, 'playwright-report', 'index.html');
    try {
      if (fs.statSync(candidate).isFile()) return path.dirname(candidate);
    } catch (_err) {}
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function parseReport(reportDir) {
  const indexPath = path.join(reportDir, 'index.html');
  let html;
  try {
    html = fs.readFileSync(indexPath, 'utf8');
  } catch (_err) {
    return null;
  }
  const m = html.match(
    /<script[^>]+id="playwrightReportBase64"[^>]*>data:application\/zip;base64,([\s\S]+?)<\/script>/,
  );
  if (!m) return null;
  let buf;
  try {
    buf = Buffer.from(m[1].trim(), 'base64');
  } catch (_err) {
    return null;
  }
  let entries;
  try {
    entries = readZipEntries(buf);
  } catch (_err) {
    return null;
  }
  const tests = [];
  for (const entry of entries) {
    if (!entry.name.endsWith('.json')) continue;
    if (entry.name === 'report.json') continue;
    let data;
    try {
      data = extractEntry(buf, entry);
    } catch (_err) {
      continue;
    }
    let fileJson;
    try {
      fileJson = JSON.parse(data.toString('utf8'));
    } catch (_err) {
      continue;
    }
    const fileName = fileJson.fileName;
    for (const t of fileJson.tests || []) {
      const videoSha1Set = new Set();
      for (const r of t.results || []) {
        for (const a of r.attachments || []) {
          if (a.name !== 'video' || !a.path) continue;
          videoSha1Set.add(path.basename(a.path).replace(/\.[^.]+$/, ''));
        }
      }
      tests.push({
        sha1Set: videoSha1Set,
        file: fileName,
        describe: Array.isArray(t.path) ? t.path : [],
        title: t.title,
        browser: t.projectName,
        line: t.location && t.location.line,
        outcome: t.outcome,
      });
    }
  }
  return tests;
}

function getReport(reportDir) {
  if (reportCache.has(reportDir)) return reportCache.get(reportDir);
  const tests = parseReport(reportDir);
  reportCache.set(reportDir, tests);
  return tests;
}

function slugifyFile(file) {
  return file.replace(/\.spec\.[tj]sx?$/, '').replace(/[\/\\]/g, '-');
}

function sanitizeForFilePath(s) {
  return String(s == null ? '' : s).replace(
    /[\x00-\x2C\x2E-\x2F\x3A-\x40\x5B-\x60\x7B-\x7F]+/g,
    '-',
  );
}

function parseDirName(dirName) {
  const retryRe = /-retry(\d+)$/;
  const retryMatch = dirName.match(retryRe);
  const retry = retryMatch ? Number.parseInt(retryMatch[1], 10) : 0;
  const noRetry = retryMatch ? dirName.slice(0, -retryMatch[0].length) : dirName;

  const browserRe = /-(chromium|firefox|webkit|chromium-headed|firefox-headed|webkit-headed)$/;
  const browserMatch = noRetry.match(browserRe);
  const browser = browserMatch ? browserMatch[1].replace(/-headed$/, '') : null;
  const rest = browserMatch ? noRetry.slice(0, -browserMatch[0].length) : noRetry;
  const hashMatch = rest.match(/^(.+?)-?-([0-9a-f]{5})-(.+)$/);
  if (!hashMatch) {
    return { fileSlug: rest, hash: null, titleTail: null, browser, retry };
  }
  return {
    fileSlug: hashMatch[1].replace(/-+$/, ''),
    hash: hashMatch[2],
    titleTail: hashMatch[3],
    browser,
    retry,
  };
}

function findMatch(tests, parsed) {
  if (!tests || !parsed || !parsed.titleTail) return null;
  const tailSan = parsed.titleTail;
  const candidates = tests.filter((t) => {
    if (parsed.browser && t.browser !== parsed.browser) return false;
    if (typeof t.title !== 'string') return false;
    if (t.title.endsWith(parsed.titleTail)) return true;
    return sanitizeForFilePath(t.title).endsWith(tailSan);
  });
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1 && parsed.fileSlug) {
    const refined = candidates.filter((t) => slugifyFile(t.file) === parsed.fileSlug);
    if (refined.length === 1) return refined[0];
  }
  return null;
}

function enrichVideo(videoPath, dirName) {
  const parsed = parseDirName(dirName);
  const direct = jsonReportReader.lookup(videoPath);
  if (direct) return { parsed, match: direct, source: 'json' };
  const reportDir = findReportDir(videoPath);
  if (!reportDir) return { parsed, match: null };
  const tests = getReport(reportDir);
  if (!tests) return { parsed, match: null };
  const match = findMatch(tests, parsed);
  return { parsed, match, source: match ? 'html' : null };
}

function resetCache() {
  reportCache.clear();
  jsonReportReader.resetCache();
}

module.exports = {
  findReportDir,
  getReport,
  parseReport,
  parseDirName,
  findMatch,
  enrichVideo,
  resetCache,
};
