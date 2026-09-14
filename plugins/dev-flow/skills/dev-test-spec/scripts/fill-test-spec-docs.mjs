#!/usr/bin/env node
// dev-test-spec: テスト計画 JSON の docs セクションを Docs 版テスト仕様書に記入する CLI
//
// 使い方:
//   node fill-test-spec-docs.mjs --doc <documentId> --plan <plan.json> [--dry-run] [--verify] [--force]
//
//   --dry-run : 読み取りと解析のみ。挿入予定（アンカー別の行数）を表示して終了（書込なし）
//   --verify  : 記入後に読み戻して、全アンカーの直後に本文があることを検算
//   --force   : 記入済みアンカーのスキップを無効化して挿入する（重複挿入になるため
//               原則使わない。作り直しは原本の再コピーが正）
//
// 前提: Docs 原本を Drive コピーした直後の対象に対して実行する。
// 認証・API 呼び出しは gws CLI（認証済み）に委譲する。

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { analyzeDoc, buildDocsRequests, headingLevel } from './generate-docs-requests.mjs';

function parseArgs(argv) {
  const args = { dryRun: false, verify: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--doc') args.doc = argv[++i];
    else if (a === '--plan') args.plan = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--verify') args.verify = true;
    else if (a === '--force') args.force = true;
    else throw new Error(`不明な引数: ${a}`);
  }
  if (!args.doc || !args.plan) {
    console.error('使い方: node fill-test-spec-docs.mjs --doc <documentId> --plan <plan.json> [--dry-run] [--verify] [--force]');
    process.exit(2);
  }
  return args;
}

function gws(argv, jsonBody) {
  const full = [...argv];
  if (jsonBody !== undefined) full.push('--json', JSON.stringify(jsonBody));
  const out = execFileSync('gws', full, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  const trimmed = out.trim();
  return trimmed ? JSON.parse(trimmed) : {};
}

const getDoc = (documentId) => gws(['docs', 'documents', 'get',
  '--params', JSON.stringify({ documentId, includeTabsContent: true })]);

function main() {
  const args = parseArgs(process.argv.slice(2));
  const plan = JSON.parse(readFileSync(args.plan, 'utf8'));

  const doc = getDoc(args.doc);
  console.error(`対象: ${doc.title}（タブ: ${(doc.tabs || []).map((tab) => tab.tabProperties.title).join(' / ')}）`);

  const { requests, todo, skipped } = buildDocsRequests(doc, plan, { force: args.force });

  if (skipped.length > 0) {
    console.error(`記入済みのためスキップ: ${skipped.length} 箇所`);
    for (const s of skipped) console.error(`  - ${s.anchorDesc}`);
  }
  if (todo.length === 0) {
    console.error('挿入対象がありません（すべて記入済み）。作り直す場合は原本を再コピーしてください');
    if (args.verify) runVerify(args.doc);
    return;
  }

  if (args.dryRun) {
    for (const tg of todo) console.error(`挿入予定: ${tg.anchorDesc}（${tg.lines.length} 行, mode=${tg.mode}）`);
    console.log(JSON.stringify(requests, null, 2));
    console.error(`dry-run: 挿入 ${todo.length} 箇所 / リクエスト ${requests.length} 件（書込は行っていません）`);
    return;
  }

  gws(['docs', 'documents', 'batchUpdate',
    '--params', JSON.stringify({ documentId: args.doc })],
    { requests });
  console.error(`記入完了: 挿入 ${todo.length} 箇所 / リクエスト ${requests.length} 件`);

  if (args.verify) runVerify(args.doc);

  console.log(`https://docs.google.com/document/d/${args.doc}/edit`);
}

function runVerify(documentId) {
  const errors = verify(documentId);
  if (errors.length > 0) {
    console.error(`検算 NG: ${errors.length} 件`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.error('検算 OK: 全タブの全セクションに本文があります');
}

// 記入後の読み戻し検算: 全タブが埋まっていること（記入放置の検出を含む）
function verify(documentId) {
  const errors = [];
  const doc = getDoc(documentId);
  const tabs = analyzeDoc(doc);

  const paraAt = (tab, pred, nth = 0) => {
    let seen = 0;
    for (const p of tab.paras) if (pred(p)) { if (seen === nth) return p; seen += 1; }
    return null;
  };
  // 次の非空段落が本文またはアンカーより下位レベルの見出しなら記入済み
  // （例: H2 テストケース一覧 の直後の H3 グループ見出し、H3 環境準備 の直後の H4）
  const contentAfter = (tab, para) => {
    const next = tab.paras.find((p) => p.startIndex >= para.endIndex && p.text.trim() !== '');
    return !!next && headingLevel(next.style) > headingLevel(para.style);
  };
  const requireFilled = (tabTitle, label, pred, nth = 0) => {
    const tab = tabs[tabTitle];
    if (!tab) { errors.push(`タブ「${tabTitle}」が見つかりません`); return; }
    const para = paraAt(tab, pred, nth);
    if (!para) { errors.push(`${tabTitle}: 「${label}」が見つかりません`); return; }
    if (!contentAfter(tab, para)) errors.push(`${tabTitle}: 「${label}」の直後に本文がありません（記入放置）`);
  };
  const isH = (level) => (p) => p.style === `HEADING_${level}`;

  // 実施概要: 開発/作成者名 ×4、URL・備考 ×4（3つ目は H4 E2EテストURL 側を見る）
  for (let i = 0; i < 4; i++) {
    requireFilled('実施概要', `開発/作成者名 (${i + 1}つ目)`, (p) => p.text.trim() === '開発/作成者名' && isH(3)(p), i);
  }
  for (const i of [0, 1, 3]) {
    requireFilled('実施概要', `URL・備考 (${i + 1}つ目)`, (p) => p.text.trim() === 'URL・備考' && isH(3)(p), i);
  }
  requireFilled('実施概要', 'E2EテストURL', (p) => p.text.trim() === 'E2EテストURL' && isH(4)(p));

  // サマリー: 「準備」プレースホルダーが残っていない・テストケース一覧に本文・結果サマリーがある
  {
    const tab = tabs['機能テスト（サマリー）'];
    if (!tab) errors.push('タブ「機能テスト（サマリー）」が見つかりません');
    else {
      if (paraAt(tab, (p) => p.text.trim() === '準備' && isH(3)(p))) {
        errors.push('機能テスト（サマリー）: 原本プレースホルダー「準備」が残っています（記入放置）');
      }
      if (!paraAt(tab, (p) => p.text.trim() === 'テスト結果サマリー' && isH(2)(p))) {
        errors.push('機能テスト（サマリー）: 「テスト結果サマリー」がありません');
      }
      requireFilled('機能テスト（サマリー）', 'テストケース一覧', (p) => p.text.trim().startsWith('テストケース一覧') && isH(2)(p));
    }
  }

  // 全タブ共通: 見出し段落に bullet が付いていないこと（挿入先の bullet 継承事故の検出。
  // 実障害: 末尾追加した H2 が「● テスト結果サマリー」になった）
  for (const [tabTitle, tab] of Object.entries(tabs)) {
    for (const p of tab.paras) {
      if (p.style.startsWith('HEADING') && p.bullet) {
        errors.push(`${tabTitle}: 見出し「${p.text.trim()}」に箇条書きマーカーが付いています（レイアウト崩れ）`);
      }
    }
  }

  // 機能テスト仕様書・本番確認テスト仕様書: 各セクションに本文、サイトURL 行に値
  for (const tabTitle of ['機能テスト仕様書', '本番確認テスト仕様書']) {
    for (const label of ['テスト環境の準備', 'テストシナリオ一覧', 'テスト結果']) {
      requireFilled(tabTitle, label, (p) => p.text.trim() === label && isH(3)(p));
    }
    requireFilled(tabTitle, '手動テスト', (p) => p.text.trim() === '手動テスト' && isH(2)(p));
    const tab = tabs[tabTitle];
    if (tab) {
      for (const label of ['サイトURL：', 'ログインID：', 'パスワード：', '権限：']) {
        const para = paraAt(tab, (p) => p.text.trim().startsWith(label));
        if (!para) errors.push(`${tabTitle}: 行「${label}」が見つかりません`);
        else if (para.text.trim().length <= label.length) errors.push(`${tabTitle}: 「${label}」に値が入っていません`);
      }
    }
  }
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
