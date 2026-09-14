#!/usr/bin/env node
// extract-test-titles: spec ファイルから describe / test / it のタイトルを抽出して JSON 出力する。
// test-ledger-writer が台帳に載せるテスト名を、LLM の転記ミス・幻覚なしに得るための決定的抽出。
//
// 使い方:
//   node extract-test-titles.mjs --repo <リポルート> [--diff <git range>]
//
// - --diff 指定時: `git diff --name-only <range>` に含まれる spec ファイルのみ対象
// - 無指定時: リポ配下の spec ファイルを全走査
// - 出力: {"files":[{"file":"e2e/a.spec.ts","titles":[{"kind":"test","title":"...","line":12}]}]}
// - 対象0件でも exit 0 だが、stderr に警告を必ず出す（無音成功で検査ゲートが素通りするのを防ぐ）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const SPEC_RE = /\.(spec|test)\.(ts|tsx|js|jsx|mjs)$|_test\.(go|py)$/i;
const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', 'vendor']);
const MAX_DEPTH = 8;

// describe / test / it の第1引数文字列リテラル。
// - Playwright の `test.describe(...)` は kind=describe として拾う（先頭の `test.` を捨てる）
// - `.only` `.skip` `.each([...])` 等の修飾子つきに対応（`.each` は引数を伴う）
const TITLE_RE =
  /\b(?:test\.)?(describe|test|it)((?:\.[\w$]+(?:\([^()]*\))?)*)\s*\(\s*(['"`])((?:\\.|(?!\3)[^\r\n\\])*)\3/g;

function parseArgs(argv) {
  const out = { repo: null, diff: null };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--repo') out.repo = argv[++i];
    else if (argv[i] === '--diff') out.diff = argv[++i];
  }
  return out;
}

function walkSpecs(dir, depth, results) {
  if (depth > MAX_DEPTH) return;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_err) {
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      walkSpecs(full, depth + 1, results);
    } else if (entry.isFile() && SPEC_RE.test(entry.name)) {
      results.push(full);
    }
  }
}

function specsFromDiff(repo, range) {
  const stdout = execFileSync('git', ['diff', '--name-only', range], { cwd: repo, encoding: 'utf8' });
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && SPEC_RE.test(line))
    .map((rel) => path.join(repo, rel))
    .filter((full) => fs.existsSync(full));
}

// 改行位置の累積配列から、文字オフセットの行番号（1始まり）を二分探索で引く
function lineOf(newlineOffsets, index) {
  let lo = 0;
  let hi = newlineOffsets.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (newlineOffsets[mid] < index) lo = mid + 1;
    else hi = mid;
  }
  return lo + 1;
}

export function extractTitles(source) {
  const newlineOffsets = [];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === '\n') newlineOffsets.push(i);
  }
  const titles = [];
  TITLE_RE.lastIndex = 0;
  let m;
  while ((m = TITLE_RE.exec(source)) !== null) {
    const title = m[4].replace(/\\(['"`\\])/g, '$1');
    if (!title) continue;
    titles.push({ kind: m[1], title, line: lineOf(newlineOffsets, m.index) });
  }
  return titles;
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.repo) {
    console.error('Usage: extract-test-titles.mjs --repo <root> [--diff <git range>]');
    process.exit(2);
  }
  const repo = path.resolve(args.repo);
  if (!fs.existsSync(repo)) {
    console.error(`ERROR: リポジトリが存在しません: ${repo}`);
    process.exit(2);
  }

  let specFiles;
  if (args.diff) {
    try {
      specFiles = specsFromDiff(repo, args.diff);
    } catch (err) {
      console.error(`ERROR: git diff --name-only ${args.diff} に失敗: ${err.message}`);
      process.exit(2);
    }
  } else {
    specFiles = [];
    walkSpecs(repo, 0, specFiles);
  }

  const files = [];
  for (const full of specFiles.sort()) {
    let source;
    try {
      source = fs.readFileSync(full, 'utf8');
    } catch (_err) {
      continue;
    }
    const titles = extractTitles(source);
    if (titles.length === 0) continue;
    files.push({ file: path.relative(repo, full).split(path.sep).join('/'), titles });
  }

  if (files.length === 0) {
    const scope = args.diff ? `差分 ${args.diff}` : `リポジトリ全体`;
    console.error(`WARNING: ${scope} に spec ファイルまたはテストタイトルが1件も見つかりませんでした（${repo}）`);
  }
  console.log(JSON.stringify({ files }, null, 2));
}

// エントリポイント判定は realpath で行う。`import.meta.url === file://${process.argv[1]}` は
// symlink 経由の起動で false になり、main() が走らないまま無音で exit 0 する
function isMain() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch (_err) {
    return false;
  }
}

if (isMain()) main();
