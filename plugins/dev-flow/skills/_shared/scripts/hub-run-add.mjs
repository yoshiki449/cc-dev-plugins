#!/usr/bin/env node
// hub-run-add: 実行マニフェスト（.agent/hub-runs/<run-id>.json）への成果物追記。
// dev-hub の「実行履歴ビュー」が読む。開発フローの各フェーズ（dev-plan の
// プラン取り込み・auto-build Finalize・dev-ship の explain-diff 等）から呼ばれる。
//
// 使い方:
//   node hub-run-add.mjs --repo <リポルート> --run <run-id> [--label <表示名>] \
//        [--flow <dev-plan|auto-build|auto-feedback|dev-ship|explain-diff|manual>] \
//        [--issue <番号>] <成果物パス>...
//
// - run-id の慣例: Issue があれば `issue-<番号>`、なければ `<YYYYMMDD-HHMM>-<slug>`
// - 成果物パスは絶対・相対どちらでも可（マニフェストにはリポルート相対で保存）
// - idempotent: 同じパスの二重追記はしない。label/flow/issue は後勝ちで更新

import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const out = { repo: null, run: null, label: null, flow: null, issue: null, paths: [] };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--repo') out.repo = argv[++i];
    else if (a === '--run') out.run = argv[++i];
    else if (a === '--label') out.label = argv[++i];
    else if (a === '--flow') out.flow = argv[++i];
    else if (a === '--issue') out.issue = Number.parseInt(argv[++i], 10);
    else out.paths.push(a);
  }
  return out;
}

const args = parseArgs(process.argv);
if (!args.repo || !args.run || args.paths.length === 0) {
  console.error('Usage: hub-run-add.mjs --repo <root> --run <run-id> [--label <l>] [--flow <f>] [--issue <n>] <path>...');
  process.exit(2);
}
if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(args.run)) {
  console.error(`ERROR: run-id が不正です: ${args.run}`);
  process.exit(2);
}

const repo = path.resolve(args.repo);
const dir = path.join(repo, '.agent', 'hub-runs');
const file = path.join(dir, `${args.run}.json`);

let manifest = { run_id: args.run, label: null, flow: null, issue: null, updated_at: null, artifacts: [] };
try {
  manifest = { ...manifest, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
} catch (_err) {}

if (args.label) manifest.label = args.label;
if (args.flow) manifest.flow = args.flow;
if (Number.isInteger(args.issue)) manifest.issue = args.issue;
manifest.updated_at = new Date().toISOString();

const existing = new Set(manifest.artifacts.map((a) => a.path));
let added = 0;
for (const p of args.paths) {
  const abs = path.resolve(repo, p);
  const rel = path.relative(repo, abs);
  if (rel.startsWith('..')) {
    console.error(`SKIP（リポ外）: ${p}`);
    continue;
  }
  const relPosix = rel.split(path.sep).join('/');
  if (existing.has(relPosix)) continue;
  if (!fs.existsSync(abs)) {
    console.error(`SKIP（存在しない）: ${p}`);
    continue;
  }
  manifest.artifacts.push({ path: relPosix });
  existing.add(relPosix);
  added += 1;
}

fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log(`[hub-run-add] ${path.relative(repo, file)}: +${added} 件（計 ${manifest.artifacts.length} 件）`);
