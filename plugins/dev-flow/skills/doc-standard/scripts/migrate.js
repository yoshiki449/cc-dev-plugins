#!/usr/bin/env node
'use strict';

// doc-standard: ドキュメント保管規約への一括移行スクリプト
//
// 規約（~/.claude/best-practices/IMPLEMENTATION.md「ドキュメント保管規約」）:
//   - ルート直下の md はツールが配置場所を規定するもののみ（README/CLAUDE/AGENTS 等）
//   - 設計md（REQUIREMENTS/DESIGN/SPEC/OPERATIONS/RUNBOOK）は docs/ へ（tracked）
//   - HANDOVER.md は .agent/ へ（運用ファイル）
//   - .agent/ は全面 gitignore（tracked 分は git rm -r --cached で剥がす）
//
// すべて idempotent。コミットは行わない（適用後に人間/Claude がリポごとにコミット）。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// ルート直下に置いてよい md（小文字比較）
const ROOT_ALLOWLIST = new Set([
  'readme.md', 'claude.md', 'agents.md', 'gemini.md',
  'license.md', 'contributing.md', 'changelog.md',
  'code_of_conduct.md', 'security.md',
]);

// docs/ へ移動する設計系パターン
const DESIGN_PATTERNS = [
  /^(requirements|design|spec)([-_.].+)?\.md$/i,
  /^(operations|runbook)\.md$/i,
];

// .agent/ へ移動する運用系パターン
const AGENT_PATTERNS = [
  /^handover([-_.].+)?\.md$/i,
];

// .agent/reports/ へ移送するレポートパターン（旧形式: .agent/ 直下）
const AGENT_REPORT_RE = /^(qa-report|security-review|security-check|triage)[-_.].*\.md$/i;

const DEFAULT_EXCLUDE_DIRS = new Set([
  'node_modules', '.git', '.cache', '.next', '.turbo', '.vercel', '.svelte-kit',
  '.nuxt', '.parcel-cache', '.yarn', '.pnpm-store', 'dist', 'build', 'out',
  'coverage', '.venv', 'venv', 'env', '__pycache__', '.pytest_cache',
  '.ruff_cache', '.mypy_cache', '.tox', 'target', 'vendor', '.terraform',
  '.gradle', '.idea', '.vscode', '.local', '.npm', '.nvm', '.cargo',
  '.rustup', '.docker', '.kube', '.android', '.gem', '.bundle', 'snap',
  'playwright-report', 'blob-report', 'test-results',
  '.claude', '.config', '.cursor', '.codex',
  '_archive', 'archive',
]);

function parseArgs(argv) {
  const out = { dir: null, all: false, dryRun: false, force: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--all') out.all = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--force') out.force = true;
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

// ---- 分類ロジック（純関数・テスト対象） ----

function classifyRootMd(name) {
  const lower = name.toLowerCase();
  if (!lower.endsWith('.md')) return 'ignore';
  if (ROOT_ALLOWLIST.has(lower)) return 'allowed';
  for (const re of DESIGN_PATTERNS) if (re.test(name)) return 'design';
  for (const re of AGENT_PATTERNS) if (re.test(name)) return 'agent';
  return 'manual';
}

// .gitignore が .agent/ 配下を既定で除外しているか。
// `.agent/*` ＋ `!.agent/<file>` の allowlist 形式も含める。部分除外（denylist）を禁じたのは
// 新しいファイルが除外漏れで混入し続けるためで、既定除外なら新規ファイルは入らない。
// ここに `.agent/` を足すと、ディレクトリごと除外されて `!` の例外が効かなくなる。
function hasFullAgentIgnore(content) {
  const FULL = new Set(['.agent', '.agent/', '/.agent', '/.agent/', '.agent/*', '/.agent/*']);
  return content.split('\n').some((raw) => FULL.has(raw.trim()));
}

// .gitignore に .agent/ を追記（既にあれば無変更）
function ensureAgentIgnore(content) {
  if (hasFullAgentIgnore(content)) return { content, changed: false };
  let out = content;
  if (out.length > 0 && !out.endsWith('\n')) out += '\n';
  out += '\n# エージェント運用ファイル（ローカル専用・ドキュメント保管規約）\n.agent/\n';
  return { content: out, changed: true };
}

// ---- git ヘルパ ----

function git(repo, args, opts = {}) {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  });
}

function isGitRepo(dir) {
  try {
    return fs.existsSync(path.join(dir, '.git'));
  } catch (_err) {
    return false;
  }
}

// 追跡済みファイルの変更・ステージがある場合のみ dirty（未追跡ファイルは対象外。
// .agent/ が未追跡のまま溜まっているリポが多く、それで弾くと移行が進まないため）
function isDirty(repo) {
  try {
    const lines = git(repo, ['status', '--porcelain']).split('\n').filter(Boolean);
    return lines.some((l) => !l.startsWith('??'));
  } catch (_err) {
    return true;
  }
}

function trackedAgentFiles(repo) {
  try {
    const out = git(repo, ['ls-files', '--', '.agent']).trim();
    return out ? out.split('\n') : [];
  } catch (_err) {
    return [];
  }
}

// 追跡中のうち .gitignore に照らして除外されるものだけ。allowlist の例外は含まれない
function ignoredTrackedAgentFiles(repo) {
  try {
    const out = git(repo, ['ls-files', '-ci', '--exclude-standard', '--', '.agent']).trim();
    return out ? out.split('\n') : [];
  } catch (_err) {
    return [];
  }
}

function isTracked(repo, relPath) {
  try {
    return git(repo, ['ls-files', '--', relPath]).trim().length > 0;
  } catch (_err) {
    return false;
  }
}

// ---- リポジトリ探索 ----

function findReposRecursive(root, results, depth, maxDepth, excludeDirs) {
  if (depth > maxDepth) return;
  if (isGitRepo(root)) {
    results.push(root);
    return; // ネストした repo（submodule 等）には降りない
  }
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (_err) {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (excludeDirs.has(entry.name)) continue;
    if (entry.isSymbolicLink()) continue;
    findReposRecursive(path.join(root, entry.name), results, depth + 1, maxDepth, excludeDirs);
  }
}

function findReposIn(dir, maxDepth) {
  const excludeDirs = new Set(DEFAULT_EXCLUDE_DIRS);
  const extras = (process.env.EXCLUDE_DIRS || '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const e of extras) excludeDirs.add(e);
  const results = [];
  findReposRecursive(path.resolve(dir), results, 0, maxDepth, excludeDirs);
  return results;
}

function findClosestRepo(startDir) {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 12; i += 1) {
    if (isGitRepo(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
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

// ---- 移動したファイルへの参照チェック（報告のみ） ----

function findMdFiles(dir, depth, maxDepth, results) {
  if (depth > maxDepth) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_err) {
    return;
  }
  for (const entry of entries) {
    if (DEFAULT_EXCLUDE_DIRS.has(entry.name)) continue;
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '.agent') continue;
      findMdFiles(full, depth + 1, maxDepth, results);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      results.push(full);
    }
  }
}

function findReferences(repo, movedBasenames) {
  const notes = [];
  if (movedBasenames.length === 0) return notes;
  const mdFiles = [];
  findMdFiles(repo, 0, 3, mdFiles);
  for (const file of mdFiles) {
    let content;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch (_err) {
      continue;
    }
    const lines = content.split('\n');
    for (const base of movedBasenames) {
      if (path.basename(file) === base) continue;
      for (let i = 0; i < lines.length; i += 1) {
        if (lines[i].includes(base)) {
          notes.push(`[LINK] ${path.relative(repo, file)}:${i + 1} が ${base} を参照（リンク切れの可能性、手動確認）`);
          break; // 同一ファイルは1件だけ報告
        }
      }
    }
  }
  return notes;
}

// ---- リポジトリ1件の処理 ----

function moveRootFile(repo, name, destDir, dryRun, notes) {
  const src = path.join(repo, name);
  const destDirAbs = path.join(repo, destDir);
  const dest = path.join(destDirAbs, name);
  if (fs.existsSync(dest)) {
    notes.push(`[FAIL] ${name}: 移動先 ${destDir}/${name} が既に存在（手動で統合してください）`);
    return { moved: false, failed: true };
  }
  const tracked = isTracked(repo, name);
  if (!dryRun) {
    try {
      fs.mkdirSync(destDirAbs, { recursive: true });
      if (destDir === '.agent') {
        // ignored ディレクトリへは「index から外して fs 移動」（git mv だと tracked のまま残るため）
        if (tracked) git(repo, ['rm', '-q', '--cached', '--', name]);
        fs.renameSync(src, dest);
      } else if (tracked) {
        git(repo, ['mv', name, path.join(destDir, name)]);
      } else {
        fs.renameSync(src, dest);
      }
    } catch (err) {
      notes.push(`[FAIL] ${name}: 移動失敗（${err.code || ''} ${err.message.split('\n')[0]}）。read-only マウント等の可能性、書き込み可能な環境で再実行してください`);
      return { moved: false, failed: true };
    }
  }
  notes.push(`moved: ${name} -> ${destDir}/${name}${tracked ? '' : '（untracked）'}`);
  // mce 形式のコメント JSON（<name>.comments.json）が隣にあれば一緒に移動
  const sidecar = `${name}.comments.json`;
  const sidecarSrc = path.join(repo, sidecar);
  if (fs.existsSync(sidecarSrc) && !fs.existsSync(path.join(destDirAbs, sidecar))) {
    if (!dryRun) {
      if (isTracked(repo, sidecar) && destDir !== '.agent') {
        git(repo, ['mv', sidecar, path.join(destDir, sidecar)]);
      } else {
        if (isTracked(repo, sidecar)) git(repo, ['rm', '-q', '--cached', '--', sidecar]);
        fs.renameSync(sidecarSrc, path.join(destDirAbs, sidecar));
      }
    }
    notes.push(`moved: ${sidecar} -> ${destDir}/${sidecar}`);
  }
  return { moved: true, failed: false };
}

function processRepo(repo, opts) {
  const notes = [];
  let changed = false;
  let failed = false;
  let manualCount = 0;

  // 0. dirty チェック
  if (isDirty(repo) && !opts.force) {
    return { repo, status: 'dirty', notes: ['[DIRTY] working tree に未コミット変更あり。--force で強行可'], manualCount: 0 };
  }

  // 1. ルート直下 md の分類と移動
  let rootEntries = [];
  try {
    rootEntries = fs.readdirSync(repo, { withFileTypes: true });
  } catch (err) {
    return { repo, status: 'fail', notes: [`read error: ${err.message}`], manualCount: 0 };
  }
  const movedBasenames = [];
  for (const entry of rootEntries) {
    if (!entry.isFile()) continue;
    const kind = classifyRootMd(entry.name);
    if (kind === 'design' || kind === 'agent') {
      const destDir = kind === 'design' ? 'docs' : '.agent';
      const r = moveRootFile(repo, entry.name, destDir, opts.dryRun, notes);
      if (r.moved) {
        changed = true;
        movedBasenames.push(entry.name);
      }
      if (r.failed) failed = true;
    } else if (kind === 'manual') {
      notes.push(`[MANUAL] ${entry.name}: 許可リスト外。docs/（レビュー文書）か .agent/（運用）かを個別判断してください`);
      manualCount += 1;
    }
  }

  // 1.5. .agent 直下の旧形式レポートを .agent/reports/ へ移送
  // （どちらも gitignore 配下なので fs 移動のみ。dev-hub のレポート正式置き場所）
  const agentDir = path.join(repo, '.agent');
  let agentFiles = [];
  try {
    agentFiles = fs.readdirSync(agentDir, { withFileTypes: true });
  } catch (_err) {}
  for (const entry of agentFiles) {
    if (!entry.isFile()) continue;
    if (!AGENT_REPORT_RE.test(entry.name)) continue;
    const dest = path.join(agentDir, 'reports', entry.name);
    if (fs.existsSync(dest)) {
      notes.push(`[MANUAL] .agent/${entry.name}: .agent/reports/ に同名あり。手動で統合してください`);
      manualCount += 1;
      continue;
    }
    if (!opts.dryRun) {
      try {
        fs.mkdirSync(path.join(agentDir, 'reports'), { recursive: true });
        fs.renameSync(path.join(agentDir, entry.name), dest);
      } catch (err) {
        notes.push(`[FAIL] .agent/${entry.name}: reports/ への移送失敗（${err.code || ''}）`);
        failed = true;
        continue;
      }
    }
    notes.push(`moved: .agent/${entry.name} -> .agent/reports/${entry.name}`);
    changed = true;
  }

  // 2. .gitignore の .agent/ 全面化
  // 対象: .agent/ が実在する・tracked がある・今回 .agent/ へ移動した、のいずれかのリポのみ。
  // （.agent と無縁なリポ＝他社製クローン等の .gitignore まで書き換えない）
  const agentRelevant =
    fs.existsSync(path.join(repo, '.agent')) ||
    trackedAgentFiles(repo).length > 0 ||
    movedBasenames.some((n) => classifyRootMd(n) === 'agent');
  const giPath = path.join(repo, '.gitignore');
  let giContent = '';
  try {
    giContent = fs.readFileSync(giPath, 'utf8');
  } catch (_err) {
    giContent = '';
  }
  const gi = agentRelevant ? ensureAgentIgnore(giContent) : { changed: false };
  if (gi.changed) {
    if (!opts.dryRun) {
      try {
        fs.writeFileSync(giPath, gi.content, 'utf8');
        notes.push('gitignore: .agent/ を追記（全面除外）');
        changed = true;
      } catch (err) {
        notes.push(`[FAIL] .gitignore 書き込み失敗（${err.code || ''}）`);
        failed = true;
      }
    } else {
      notes.push('gitignore: .agent/ を追記（全面除外）');
      changed = true;
    }
  }

  // 3. tracked な .agent/ 配下の剥がし
  // 今回 .agent/ を追記した場合は全部が対象（dry-run では .gitignore をまだ書いていないので git に聞けない）。
  // 既に除外があるなら、その .gitignore で除外されるものだけを剥がし、allowlist の例外は残す。
  const tracked = gi.changed ? trackedAgentFiles(repo) : ignoredTrackedAgentFiles(repo);
  if (tracked.length > 0) {
    if (!opts.dryRun) {
      try {
        git(repo, ['rm', '-q', '--cached', '--', ...tracked]);
      } catch (err) {
        notes.push(`[FAIL] git rm --cached .agent 失敗: ${err.message}`);
        failed = true;
      }
    }
    notes.push(`untracked: .agent/ 配下 ${tracked.length} ファイルを index から削除（ローカルには残る）`);
    changed = true;
  }

  // 4. 参照チェック（報告のみ）
  notes.push(...findReferences(repo, movedBasenames));

  let status;
  if (failed && changed) status = 'partial';
  else if (failed) status = 'fail';
  else if (changed) status = 'updated';
  else status = 'skip';
  return { repo, status, notes, manualCount };
}

// ---- main ----

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write(
      'Usage: migrate.js [--dir <path>] [--all] [--dry-run] [--force]\n' +
      '  (no args)     cwd から最寄りの git リポジトリ1件を処理\n' +
      '  --dir <path>  指定ディレクトリ配下の git リポジトリを走査（深さ6）\n' +
      '  --all         SCAN_ROOTS（既定: ホーム配下）を走査（深さ8、_archive/archive 除外）\n' +
      '  --dry-run     変更を書き込まず実行予定を表示\n' +
      '  --force       working tree が dirty のリポジトリも処理する\n',
    );
    return;
  }

  let repos = [];
  if (args.all) {
    for (const root of scanRoots()) repos.push(...findReposIn(root, 8));
  } else if (args.dir) {
    repos = findReposIn(args.dir, 6);
  } else {
    const closest = findClosestRepo(process.cwd());
    if (closest) repos = [closest];
  }
  repos = [...new Set(repos)];

  if (repos.length === 0) {
    process.stdout.write('[doc-standard] git リポジトリが見つかりません。\n');
    return;
  }

  process.stdout.write(`[doc-standard] ${repos.length} リポジトリを検査します。dry-run=${args.dryRun}\n\n`);

  const counts = { updated: 0, partial: 0, skip: 0, dirty: 0, fail: 0 };
  let manualTotal = 0;
  for (const repo of repos) {
    let r;
    try {
      r = processRepo(repo, { dryRun: args.dryRun, force: args.force });
    } catch (err) {
      r = { repo, status: 'fail', notes: [`[FAIL] 予期しないエラー: ${err.message.split('\n')[0]}`], manualCount: 0 };
    }
    counts[r.status] = (counts[r.status] || 0) + 1;
    manualTotal += r.manualCount;
    const label =
      r.status === 'updated' ? (args.dryRun ? 'WOULD UPDATE' : 'UPDATED')
      : r.status === 'partial' ? (args.dryRun ? 'WOULD PARTIAL UPDATE' : 'PARTIAL')
      : r.status === 'skip' ? 'SKIPPED'
      : r.status === 'dirty' ? 'DIRTY'
      : 'FAILED';
    // 準拠済みで報告事項もないリポは1行に圧縮
    if (r.status === 'skip' && r.notes.length === 0) {
      process.stdout.write(`[${label}] ${repo}\n`);
      continue;
    }
    process.stdout.write(`[${label}] ${repo}\n`);
    for (const n of r.notes) process.stdout.write(`  ${n}\n`);
    process.stdout.write('\n');
  }
  process.stdout.write(
    `summary: updated=${counts.updated} partial=${counts.partial} skipped=${counts.skip}` +
    ` dirty=${counts.dirty} failed=${counts.fail} manual-files=${manualTotal}\n`,
  );
}

module.exports = {
  classifyRootMd,
  hasFullAgentIgnore,
  ensureAgentIgnore,
  findClosestRepo,
  findReposIn,
  processRepo,
};

if (require.main === module) main();
