import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import mod from './scanDocs.js';

const { scanDocs, scanHub, classifyDocPath, classifyRunArtifact, GLOBAL_PROJECT } = mod;

test('classifyDocPath: 規約パスの分類', () => {
  assert.equal(classifyDocPath('docs/plans/2026-07-07-x.md'), 'plan');
  assert.equal(classifyDocPath('docs/DESIGN.md'), 'doc');
  assert.equal(classifyDocPath('docs/sub/REQUIREMENTS.md'), 'doc');
  assert.equal(classifyDocPath('docs/plans.md'), 'doc');
  assert.equal(classifyDocPath('.agent/explanations/2026-07-07-a.html'), 'explanation');
  assert.equal(classifyDocPath('.agent/explanations/a.htm'), 'explanation');
  assert.equal(classifyDocPath('docs/x.txt'), null);
  assert.equal(classifyDocPath('README.md'), null);
  assert.equal(classifyDocPath('.agent/history.md'), null);
  assert.equal(classifyDocPath('src/docs/x.md'), null);
  // レポート類
  assert.equal(classifyDocPath('.agent/qa-report-227.md'), 'report');
  assert.equal(classifyDocPath('.agent/security-review-15.md'), 'report');
  assert.equal(classifyDocPath('.agent/triage-20260708.md'), 'report');
  assert.equal(classifyDocPath('.agent/evidence/227/qa/findings-ux.md'), 'report');
  assert.equal(classifyDocPath('.agent/evidence/227/qa/qa-brief.md'), 'report');
  assert.equal(classifyDocPath('.agent/evidence/227/qa/exploration-log.md'), null);
  assert.equal(classifyDocPath('.agent/handover-20260101.md'), null);
  // テスト台帳（dev-test-ledger の出力）
  assert.equal(classifyDocPath('.agent/test-ledger/17.md'), 'ledger');
  assert.equal(classifyDocPath('.agent/test-ledger/sub/24.md'), 'ledger');
  assert.equal(classifyDocPath('.agent/test-ledger/17.txt'), null);
});

function write(base, rel, content) {
  const full = path.join(base, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

test('scanDocs: 疑似リポ＋ネスト worktree＋グローバルを統合スキャンする', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-hub-test-'));
  try {
    // 疑似リポ myapp
    const repo = path.join(tmp, 'ws', 'myapp');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    write(repo, 'docs/DESIGN.md', '# 設計書タイトル\n本文');
    write(repo, 'docs/plans/2026-07-07-plan.md', '# プランタイトル\n本文');
    write(repo, '.agent/explanations/2026-07-07-exp.html', '<title>説明タイトル</title><body>x</body>');
    write(repo, '.agent/test-ledger/24.md', '# テスト台帳タイトル\n本文');
    write(repo, '.agent/history.md', '# 対象外');
    write(repo, 'README.md', '# 対象外');
    // ネスト worktree（.claude/worktrees/wt1、親リポのプロジェクト名で集計される）
    const wt = path.join(repo, '.claude', 'worktrees', 'wt1');
    fs.mkdirSync(path.join(wt, '.git'), { recursive: true });
    write(wt, 'docs/WT-DOC.md', '# worktree 内ドキュメント');
    // グローバル
    const gExp = path.join(tmp, 'global-expl');
    const gPlan = path.join(tmp, 'global-plans');
    write(gExp, 'g.html', '<title>グローバル説明</title>');
    write(gPlan, 'g.md', '# グローバルプラン');

    const config = {
      scanRoots: [path.join(tmp, 'ws')],
      excludeDirs: new Set(['node_modules', '.git']),
      maxDepth: 8,
      globalDirs: [gExp, gPlan],
    };
    const items = scanDocs(config);

    const byTitle = Object.fromEntries(items.map((i) => [i.title, i]));
    assert.equal(items.length, 7, JSON.stringify(items.map((i) => i.path), null, 2));

    assert.equal(byTitle['設計書タイトル'].type, 'doc');
    assert.equal(byTitle['設計書タイトル'].project, 'myapp');
    assert.equal(byTitle['プランタイトル'].type, 'plan');
    assert.equal(byTitle['説明タイトル'].type, 'explanation');
    assert.equal(byTitle['テスト台帳タイトル'].type, 'ledger');
    assert.equal(byTitle['テスト台帳タイトル'].project, 'myapp');

    // ネスト worktree: 親リポのプロジェクト名＋worktree 名
    assert.equal(byTitle['worktree 内ドキュメント'].project, 'myapp');
    assert.equal(byTitle['worktree 内ドキュメント'].worktree, 'wt1');

    // グローバル
    assert.equal(byTitle['グローバル説明'].type, 'explanation');
    assert.equal(byTitle['グローバル説明'].project, GLOBAL_PROJECT);
    assert.equal(byTitle['グローバルプラン'].type, 'plan');
    assert.equal(byTitle['グローバルプラン'].project, GLOBAL_PROJECT);

    // mtime 降順ソート
    for (let i = 1; i < items.length; i += 1) {
      assert.ok(items[i - 1].mtime >= items[i].mtime);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('scanDocs: 見出しの無い md はファイル名がタイトルになる', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-hub-test-'));
  try {
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    write(repo, 'docs/no-heading.md', 'ただの本文\n');
    const items = scanDocs({
      scanRoots: [tmp],
      excludeDirs: new Set(),
      maxDepth: 4,
      globalDirs: [],
    });
    assert.equal(items.length, 1);
    assert.equal(items[0].title, 'no-heading');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('scanHub: 実行マニフェストを読み、スキャン仕様外の成果物も item 化する', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-hub-test-'));
  try {
    const repo = path.join(tmp, 'myapp');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    write(repo, 'docs/DESIGN.md', '# 設計');
    write(repo, '.agent/qa-report-12.md', '# QA レポート'); // スキャン仕様外
    write(repo, '.agent/explanations/e.html', '<title>説明</title>');
    write(repo, '.agent/hub-runs/issue-12.json', JSON.stringify({
      run_id: 'issue-12',
      label: 'dev-hub Phase 1',
      flow: 'auto-build',
      issue: 12,
      artifacts: [
        { path: 'docs/DESIGN.md' },
        { path: '.agent/qa-report-12.md' },
        { path: '.agent/explanations/e.html' },
        { path: '.agent/missing.md' },       // 存在しない → スキップ
        { path: '../outside.md' },           // リポ外 → 無視
      ],
    }));

    const config = {
      scanRoots: [tmp],
      excludeDirs: new Set(['node_modules', '.git']),
      maxDepth: 6,
      globalDirs: [],
    };
    const { items, runs } = scanHub(config);

    assert.equal(runs.length, 1);
    const run = runs[0];
    assert.equal(run.runId, 'issue-12');
    assert.equal(run.label, 'dev-hub Phase 1');
    assert.equal(run.flow, 'auto-build');
    assert.equal(run.issue, 12);
    assert.equal(run.project, 'myapp');
    assert.equal(run.artifactPaths.length, 3); // missing と リポ外 は除外

    // スキャン仕様外の QA レポートも item 化されている
    const qa = items.find((i) => i.name === 'qa-report-12.md');
    assert.ok(qa);
    assert.equal(qa.type, 'report');
    assert.equal(qa.title, 'QA レポート');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('classifyRunArtifact: 規約パス優先＋拡張子フォールバック', () => {
  assert.equal(classifyRunArtifact('docs/plans/x.md'), 'plan');
  assert.equal(classifyRunArtifact('.agent/qa-report.md'), 'report');
  assert.equal(classifyRunArtifact('.agent/autopilot/x/log.md'), 'report');
  // 規約パスが .agent/**.md → 'report' フォールバックより優先されること
  assert.equal(classifyRunArtifact('.agent/test-ledger/24.md'), 'ledger');
  assert.equal(classifyRunArtifact('notes.md'), 'doc');
  assert.equal(classifyRunArtifact('.agent/autopilot/x/review/videos/e2e/v.webm'), 'video');
  assert.equal(classifyRunArtifact('report.html'), 'explanation');
  assert.equal(classifyRunArtifact('data.json'), null);
});

test('scanHub: 傘プロジェクト（.git なし・.agent あり）と配下リポの両方を走査する', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-hub-test-'));
  try {
    // 傘: hrms/（.git なし、.agent と docs を持つ）
    const umbrella = path.join(tmp, 'hrms');
    write(umbrella, '.agent/qa-report-227.md', '# QA報告 227');
    write(umbrella, '.agent/evidence/227/qa/findings-ux.md', '# UX 所見');
    write(umbrella, '.agent/evidence/227/qa/exploration-log.md', '# 対象外ログ');
    write(umbrella, 'docs/OPERATIONS.md', '# 運用手順');
    // 配下の git リポ
    const sub = path.join(umbrella, 'backend');
    fs.mkdirSync(path.join(sub, '.git'), { recursive: true });
    write(sub, 'docs/DESIGN.md', '# バックエンド設計');

    const { items } = scanHub({
      scanRoots: [tmp],
      excludeDirs: new Set(['node_modules', '.git']),
      maxDepth: 6,
      globalDirs: [],
    });
    const byTitle = Object.fromEntries(items.map((i) => [i.title, i]));
    assert.equal(byTitle['QA報告 227'].type, 'report');
    assert.equal(byTitle['QA報告 227'].project, 'hrms');
    assert.equal(byTitle['UX 所見'].type, 'report');
    assert.equal(byTitle['運用手順'].project, 'hrms');
    assert.equal(byTitle['バックエンド設計'].project, 'backend');
    assert.ok(!byTitle['対象外ログ']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('scanDocs: 空ファイル・存在しない globalDirs は無視される', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-hub-test-'));
  try {
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    write(repo, 'docs/empty.md', '');
    const items = scanDocs({
      scanRoots: [tmp],
      excludeDirs: new Set(),
      maxDepth: 4,
      globalDirs: [path.join(tmp, 'no-such-dir')],
    });
    assert.equal(items.length, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
