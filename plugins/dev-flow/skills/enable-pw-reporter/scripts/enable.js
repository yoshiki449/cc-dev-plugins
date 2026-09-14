#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const JSON_ENTRY = "['json', { outputFile: 'test-results/results.json' }]";
const FULL_REPORTER_BLOCK =
  "  reporter: [\n" +
  "    ['list'],\n" +
  "    ['html', { open: 'never', outputFolder: 'playwright-report' }],\n" +
  "    " + JSON_ENTRY + ",\n" +
  "  ],";

const USE_RECORDING_KEYS = {
  viewport: '{ width: 1920, height: 1080 }',
  video: "'on'",
  screenshot: "'on'",
  trace: "'on'",
};
const FULL_USE_BLOCK =
  "  use: {\n" +
  "    viewport: { width: 1920, height: 1080 },\n" +
  "    video: 'on',\n" +
  "    screenshot: 'on',\n" +
  "    trace: 'on',\n" +
  "  },";

const CONFIG_NAMES = new Set([
  'playwright.config.ts',
  'playwright.config.js',
  'playwright.config.mjs',
  'playwright.config.cjs',
]);

const DEFAULT_EXCLUDE_DIRS = new Set([
  'node_modules', '.git', '.cache', '.next', '.turbo', '.vercel', '.svelte-kit',
  '.nuxt', '.parcel-cache', '.yarn', '.pnpm-store', 'dist', 'build', 'out',
  'coverage', '.venv', 'venv', 'env', '__pycache__', '.pytest_cache',
  '.ruff_cache', '.mypy_cache', '.tox', 'target', 'vendor', '.terraform',
  '.gradle', '.idea', '.vscode', '.local', '.npm', '.nvm', '.cargo',
  '.rustup', '.docker', '.kube', '.android', '.gem', '.bundle', 'snap',
  'playwright-report', 'blob-report', 'test-results',
  '.claude', '.config', '.cursor', '.codex',
]);

function parseArgs(argv) {
  const out = { dir: null, all: false, dryRun: false, verify: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--all') out.all = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--verify') out.verify = true;
    else if (a === '--dir') {
      out.dir = argv[i + 1];
      i += 1;
    } else if (a === '--help' || a === '-h') out.help = true;
    else {
      console.error(`Unknown arg: ${a}`);
      out.help = true;
    }
  }
  return out;
}

function detectHomeDirs() {
  const found = new Set();
  for (const base of ['/home', '/Users']) {
    let entries;
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch (_err) {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;
      if (entry.name === 'shared' || entry.name === 'lost+found') continue;
      found.add(path.join(base, entry.name));
    }
  }
  const home = os.homedir();
  if (fs.existsSync(home)) found.add(home);
  return [...found];
}

function scanRoots() {
  if (process.env.SCAN_ROOTS) {
    return process.env.SCAN_ROOTS.split(':').filter(Boolean);
  }
  return detectHomeDirs();
}

function findConfigsRecursive(root, results, depth, maxDepth, excludeDirs) {
  if (depth > maxDepth) return;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (_err) {
    return;
  }
  for (const entry of entries) {
    if (excludeDirs.has(entry.name)) continue;
    if (entry.isSymbolicLink()) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      findConfigsRecursive(full, results, depth + 1, maxDepth, excludeDirs);
    } else if (entry.isFile() && CONFIG_NAMES.has(entry.name)) {
      results.push(full);
    }
  }
}

function findConfigsIn(dir, maxDepth) {
  const excludeDirs = new Set(DEFAULT_EXCLUDE_DIRS);
  const extras = (process.env.EXCLUDE_DIRS || '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const e of extras) excludeDirs.add(e);
  const results = [];
  findConfigsRecursive(dir, results, 0, maxDepth, excludeDirs);
  return results;
}

function findClosestConfig(startDir) {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 8; i += 1) {
    for (const name of CONFIG_NAMES) {
      const p = path.join(dir, name);
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch (_err) {}
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const found = findConfigsIn(startDir, 4);
  return found[0] || null;
}

function findMatchingClose(text, openIdx, openChar, closeChar) {
  let depth = 0;
  let inString = null;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = openIdx; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') { inBlockComment = false; i += 1; }
      continue;
    }
    if (inString) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '/' && next === '/') { inLineComment = true; i += 1; continue; }
    if (ch === '/' && next === '*') { inBlockComment = true; i += 1; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { inString = ch; continue; }
    if (ch === openChar) depth += 1;
    else if (ch === closeChar) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function findReporterValueRange(content) {
  const re = /\breporter\s*:\s*/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const before = content.slice(Math.max(0, m.index - 80), m.index);
    if (/\/\/[^\n]*$/.test(before)) continue;
    const valueStart = m.index + m[0].length;
    const firstCh = content[valueStart];
    if (firstCh === '[') {
      const end = findMatchingClose(content, valueStart, '[', ']');
      if (end === -1) continue;
      return { propStart: m.index, valueStart, valueEnd: end + 1, kind: 'array' };
    }
    if (firstCh === "'" || firstCh === '"' || firstCh === '`') {
      const closeRe = new RegExp(`\\\\.|${firstCh}`, 'g');
      closeRe.lastIndex = valueStart + 1;
      let cm;
      while ((cm = closeRe.exec(content)) !== null) {
        if (cm[0] === firstCh) {
          return { propStart: m.index, valueStart, valueEnd: cm.index + 1, kind: 'string' };
        }
      }
      continue;
    }
    return { propStart: m.index, valueStart, valueEnd: valueStart, kind: 'complex' };
  }
  return null;
}

function findUseObjectRange(content) {
  const re = /\buse\s*:\s*\{/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const before = content.slice(Math.max(0, m.index - 80), m.index);
    if (/\/\/[^\n]*$/.test(before)) continue;
    const braceOpen = m.index + m[0].length - 1;
    const braceClose = findMatchingClose(content, braceOpen, '{', '}');
    if (braceClose === -1) continue;
    return {
      propStart: m.index,
      bodyStart: braceOpen + 1,
      bodyEnd: braceClose,
      blockEnd: braceClose + 1,
    };
  }
  return null;
}

function hasJsonReporter(content, range) {
  const slice = content.slice(range.valueStart, range.valueEnd);
  return /['"`]json['"`]/.test(slice);
}

// reporter 配列の中身をトップレベル要素に分割する。
// 文字列・行コメント・ブロックコメントは findMatchingClose と同じ厳密さで読み飛ばすので、
// ネストした文字列（['html', { outputFolder: 'x' }] の 'x'）やコメント内の記述には反応しない。
// 返り値は元 content 上のオフセット付き（コメント・空白を除いた実コードの範囲）。
function splitTopLevelElements(content, innerStart, innerEnd) {
  const elements = [];
  let depth = 0;
  let inString = null;
  let inLineComment = false;
  let inBlockComment = false;
  let segFirst = -1;
  let segLast = -1;

  const markCode = (i) => {
    if (segFirst === -1) segFirst = i;
    segLast = i + 1;
  };
  const flush = () => {
    if (segFirst !== -1) {
      elements.push({ start: segFirst, end: segLast, text: content.slice(segFirst, segLast) });
    }
    segFirst = -1;
    segLast = -1;
  };

  for (let i = innerStart; i < innerEnd; i += 1) {
    const ch = content[i];
    const next = content[i + 1];
    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') { inBlockComment = false; i += 1; }
      continue;
    }
    if (inString) {
      markCode(i);
      if (ch === '\\') { markCode(i + 1); i += 1; continue; }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '/' && next === '/') { inLineComment = true; i += 1; continue; }
    if (ch === '/' && next === '*') { inBlockComment = true; i += 1; continue; }
    if (ch === ',' && depth === 0) { flush(); continue; }
    if (/\s/.test(ch)) continue;
    markCode(i);
    if (ch === '"' || ch === "'" || ch === '`') { inString = ch; continue; }
    if (ch === '[' || ch === '{' || ch === '(') { depth += 1; continue; }
    if (ch === ']' || ch === '}' || ch === ')') { depth -= 1; continue; }
  }
  flush();
  return elements;
}

// reporter 配列のトップレベルにある「裸の文字列要素」（例: reporter: ["html", ...]）を返す。
// Playwright は配列形式の各要素にタプル（[name] / [name, options]）を要求するため、
// 裸の文字列があると config 読み込みの時点で失敗する。
function findBareReporterElements(content, range) {
  if (!range || range.kind !== 'array') return [];
  return splitTopLevelElements(content, range.valueStart + 1, range.valueEnd - 1)
    .filter((e) => /^['"`]/.test(e.text));
}

// 裸の文字列要素を [ ] で包んで修復する。後ろの要素から置換してオフセットを保つ。
function repairBareReporterElements(content, range) {
  const bare = findBareReporterElements(content, range);
  if (bare.length === 0) return { changed: false, content, range, count: 0 };
  let out = content;
  for (let i = bare.length - 1; i >= 0; i -= 1) {
    const e = bare[i];
    out = out.slice(0, e.start) + '[' + e.text + ']' + out.slice(e.end);
  }
  return {
    changed: true,
    content: out,
    range: Object.assign({}, range, { valueEnd: range.valueEnd + bare.length * 2 }),
    count: bare.length,
  };
}

function patchReporter(content) {
  let range = findReporterValueRange(content);
  if (range) {
    if (range.kind === 'complex') {
      return {
        changed: false,
        content,
        notes: ['reporter:complex expression — manual review needed (e.g. process.env.CI ? ... )'],
        fail: true,
      };
    }

    // 修復パスは hasJsonReporter の早期 return より「前」に置く。
    // 過去に本スクリプトが生成した壊れた config にも 'json' が含まれるため、
    // 後ろに置くと「already present」でスキップされて永久に直らない。
    const notes = [];
    let working = content;
    const repair = repairBareReporterElements(content, range);
    if (repair.changed) {
      working = repair.content;
      range = repair.range;
      notes.push(`reporter:repair ${repair.count} bare string element(s)`);
    }

    if (hasJsonReporter(working, range)) {
      if (repair.changed) return { changed: true, content: working, notes };
      return { changed: false, content, notes: ['reporter:json already present'] };
    }
    const oldValue = working.slice(range.valueStart, range.valueEnd);
    let newValue;
    if (range.kind === 'array') {
      const inner = oldValue.slice(1, -1);
      const innerTrimmedEnd = inner.replace(/\s+$/, '');
      // 空配列（reporter: []）にカンマを足すと `[,` という要素の穴（elision）ができ、
      // reporter[0] が undefined になって Playwright が読めなくなる。
      // patchUseRecording 側と同じく空判定を入れる。
      const trailingComma =
        innerTrimmedEnd === '' || /,\s*$/.test(innerTrimmedEnd) ? '' : ',';
      newValue = '[' + innerTrimmedEnd + trailingComma + '\n    ' + JSON_ENTRY + ',\n  ]';
    } else {
      // 配列形式にする場合、各要素はタプル（[name] / [name, options]）でなければならない。
      // oldValue はクォート込みの文字列リテラル（例: "html"）なので、必ず [ ] で包む。
      newValue = '[\n    [' + oldValue + '],\n    ' + JSON_ENTRY + ',\n  ]';
    }
    const newContent =
      working.slice(0, range.valueStart) + newValue + working.slice(range.valueEnd);
    notes.push('reporter:append json entry');
    return { changed: true, content: newContent, notes };
  }

  const dcMatch = content.match(/defineConfig\s*\(\s*\{/);
  if (!dcMatch) {
    return { changed: false, content, notes: ['reporter:no defineConfig'], fail: true };
  }
  const insertPos = dcMatch.index + dcMatch[0].length;
  const newContent =
    content.slice(0, insertPos) + '\n' + FULL_REPORTER_BLOCK + content.slice(insertPos);
  return { changed: true, content: newContent, notes: ['reporter:insert full block'] };
}

function patchUseRecording(content) {
  const range = findUseObjectRange(content);
  if (range) {
    const body = content.slice(range.bodyStart, range.bodyEnd);
    const missing = [];
    for (const key of Object.keys(USE_RECORDING_KEYS)) {
      const re = new RegExp(`\\b${key}\\s*:`);
      if (!re.test(body)) missing.push(key);
    }
    if (missing.length === 0) {
      return { changed: false, content, notes: ['use:viewport/video/screenshot/trace already present'] };
    }
    const trimmedBody = body.replace(/\s+$/, '');
    const trailingComma = trimmedBody === '' || /,\s*$/.test(trimmedBody) ? '' : ',';
    const additions = missing
      .map((k) => `    ${k}: ${USE_RECORDING_KEYS[k]},`)
      .join('\n');
    const newBody = trimmedBody + trailingComma + '\n' + additions + '\n  ';
    const newContent =
      content.slice(0, range.bodyStart) + newBody + content.slice(range.bodyEnd);
    return {
      changed: true,
      content: newContent,
      notes: [`use:append ${missing.join('/')}`],
    };
  }
  const dcMatch = content.match(/defineConfig\s*\(\s*\{/);
  if (!dcMatch) {
    return { changed: false, content, notes: ['use:no defineConfig'], fail: true };
  }
  const insertPos = dcMatch.index + dcMatch[0].length;
  const newContent =
    content.slice(0, insertPos) + '\n' + FULL_USE_BLOCK + content.slice(insertPos);
  return { changed: true, content: newContent, notes: ['use:insert full block'] };
}

function patchConfig(content) {
  let current = content;
  const notes = [];
  let anyChange = false;
  let failed = false;

  const r = patchReporter(current);
  current = r.content;
  notes.push(...(r.notes || []));
  if (r.changed) anyChange = true;
  if (r.fail) failed = true;

  const u = patchUseRecording(current);
  current = u.content;
  notes.push(...(u.notes || []));
  if (u.changed) anyChange = true;
  if (u.fail) failed = true;

  let status;
  if (failed && anyChange) status = 'partial';
  else if (failed && !anyChange) status = 'fail';
  else if (anyChange) status = 'updated';
  else status = 'skip';

  return { changed: anyChange, content: current, status, reason: notes.join(' / ') };
}

function unifiedDiff(oldText, newText, filePath) {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) {
    start += 1;
  }
  let endOld = oldLines.length - 1;
  let endNew = newLines.length - 1;
  while (endOld > start && endNew > start && oldLines[endOld] === newLines[endNew]) {
    endOld -= 1;
    endNew -= 1;
  }
  const ctxStart = Math.max(0, start - 2);
  const ctxEndOld = Math.min(oldLines.length - 1, endOld + 2);
  const ctxEndNew = Math.min(newLines.length - 1, endNew + 2);
  const lines = [`--- ${filePath}`, `+++ ${filePath}`];
  for (let i = ctxStart; i <= ctxEndOld && i <= ctxEndNew && i < start; i += 1) {
    lines.push('  ' + oldLines[i]);
  }
  for (let i = start; i <= endOld; i += 1) lines.push('- ' + oldLines[i]);
  for (let i = start; i <= endNew; i += 1) lines.push('+ ' + newLines[i]);
  for (let i = Math.max(endOld + 1, endNew + 1); i <= Math.min(ctxEndOld, ctxEndNew); i += 1) {
    if (oldLines[i] != null) lines.push('  ' + oldLines[i]);
  }
  return lines.join('\n');
}

// 書き込んだ config が Playwright に実際に読めるかを検証する（--verify のときだけ呼ばれる）。
// このスクリプトの失敗は「書き換えは成功したが生成物が不正」という形で出るため、
// 書き込み処理からは成功に見えてしまう。検証できない環境では黙って成功扱いにせず notes に残す。
function verifyWithPlaywright(filePath) {
  const dir = path.dirname(filePath);
  try {
    require.resolve('@playwright/test/package.json', { paths: [dir] });
  } catch (_err) {
    return { ok: true, note: 'verify:skipped (@playwright/test not installed)' };
  }
  const res = spawnSync('npx', ['playwright', 'test', '--list', '--config', filePath], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 180000,
  });
  if (res.error) {
    return { ok: true, note: `verify:skipped (${res.error.message})` };
  }
  if (res.status === 0) return { ok: true, note: 'verify:playwright --list ok' };
  const detail = ((res.stderr || '') + (res.stdout || ''))
    .trim().split('\n').slice(0, 3).join(' | ');
  return { ok: false, note: `verify:playwright --list failed — ${detail}` };
}

function processConfig(filePath, dryRun, verify) {
  let original;
  try {
    original = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return { filePath, status: 'fail', reason: `read error: ${err.message}` };
  }
  const result = patchConfig(original);
  if (!result.changed) {
    return { filePath, status: result.status, reason: result.reason };
  }
  const diff = unifiedDiff(original, result.content, filePath);
  if (dryRun) {
    const reason = verify ? `${result.reason} / verify:skipped (dry-run)` : result.reason;
    return { filePath, status: result.status, reason, diff };
  }
  try {
    fs.writeFileSync(filePath, result.content, 'utf8');
  } catch (err) {
    return { filePath, status: 'fail', reason: `write error: ${err.message}`, diff };
  }
  if (verify) {
    const v = verifyWithPlaywright(filePath);
    const reason = `${result.reason} / ${v.note}`;
    if (!v.ok) {
      try {
        fs.writeFileSync(filePath, original, 'utf8');
        return { filePath, status: 'fail', reason: `${reason} / restored original`, diff };
      } catch (err) {
        return { filePath, status: 'fail', reason: `${reason} / restore failed: ${err.message}`, diff };
      }
    }
    return { filePath, status: result.status, reason, diff };
  }
  return { filePath, status: result.status, reason: result.reason, diff };
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write(
      'Usage: enable.js [--dir <path>] [--all] [--dry-run]\n' +
      '  (no args) update the closest playwright.config.* from cwd\n' +
      '  --dir <path>  scan that directory (depth 4)\n' +
      '  --all         scan ~/ home directories (cross-platform)\n' +
      '  --dry-run     show diff without writing\n' +
      '  --verify      after writing, run `npx playwright test --list` and\n' +
      '                restore the original file if it fails (off by default)\n',
    );
    return;
  }

  let configs = [];
  if (args.all) {
    for (const root of scanRoots()) configs.push(...findConfigsIn(root, 12));
  } else if (args.dir) {
    configs = findConfigsIn(path.resolve(args.dir), 6);
  } else {
    const closest = findClosestConfig(process.cwd());
    if (closest) configs = [closest];
  }

  configs = [...new Set(configs)];

  if (configs.length === 0) {
    process.stdout.write('[enable-pw-reporter] no playwright.config.* found.\n');
    return;
  }

  process.stdout.write(
    `[enable-pw-reporter] ${configs.length} config(s) found. dry-run=${args.dryRun} verify=${args.verify}\n\n`,
  );

  const counts = { updated: 0, partial: 0, skip: 0, fail: 0 };
  for (const cfg of configs) {
    const r = processConfig(cfg, args.dryRun, args.verify);
    counts[r.status] = (counts[r.status] || 0) + 1;
    const label =
      r.status === 'updated' ? (args.dryRun ? 'WOULD UPDATE' : 'UPDATED')
      : r.status === 'partial' ? (args.dryRun ? 'WOULD PARTIAL UPDATE' : 'PARTIAL')
      : r.status === 'skip' ? 'SKIPPED'
      : 'FAILED';
    process.stdout.write(`[${label}] ${cfg}\n  reason: ${r.reason}\n`);
    if (r.diff) process.stdout.write(r.diff + '\n');
    process.stdout.write('\n');
  }
  process.stdout.write(
    `[enable-pw-reporter] summary: updated=${counts.updated || 0} partial=${counts.partial || 0} skipped=${counts.skip || 0} failed=${counts.fail || 0}\n`,
  );
  if (args.dryRun) {
    process.stdout.write('[enable-pw-reporter] dry-run mode — no files were modified.\n');
  }
}

if (require.main === module) main();

module.exports = {
  patchConfig,
  patchReporter,
  findReporterValueRange,
  findBareReporterElements,
  splitTopLevelElements,
  findClosestConfig,
  findConfigsIn,
};
