#!/usr/bin/env node
// dev-test-spec: テスト計画 JSON をスプレッドシート版テスト仕様書に記入する CLI
//
// 使い方:
//   node fill-test-spec.mjs --spreadsheet <ID> --plan <plan.json> [--dry-run] [--verify] [--force]
//
//   --dry-run : 読み取りと解析のみ行い、生成したリクエスト JSON を表示して終了（書込なし）
//   --verify  : 記入後に値と結合を読み戻して plan と突き合わせ、差異があれば exit 1
//   --force   : 既記入ガード（手順行に値が残っている場合の停止）を無視して上書き
//
// 前提: 原本スプレッドシートを Drive コピーした直後の対象に対して実行する。
// 認証・API 呼び出しは gws CLI（認証済み）に委譲する。

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  SHEET_FUNC, SHEET_OVERVIEW,
  analyzeTemplate, buildRequests, findExistingContent,
} from './generate-requests.mjs';

function parseArgs(argv) {
  const args = { dryRun: false, verify: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--spreadsheet') args.spreadsheet = argv[++i];
    else if (a === '--plan') args.plan = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--verify') args.verify = true;
    else if (a === '--force') args.force = true;
    else throw new Error(`不明な引数: ${a}`);
  }
  if (!args.spreadsheet || !args.plan) {
    console.error('使い方: node fill-test-spec.mjs --spreadsheet <ID> --plan <plan.json> [--dry-run] [--verify] [--force]');
    process.exit(2);
  }
  return args;
}

// gws CLI 呼び出し（stdout の JSON をパースして返す）
function gws(argv, jsonBody) {
  const full = [...argv];
  if (jsonBody !== undefined) full.push('--json', JSON.stringify(jsonBody));
  const out = execFileSync('gws', full, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const trimmed = out.trim();
  return trimmed ? JSON.parse(trimmed) : {};
}

function getValues(spreadsheetId, range) {
  const res = gws(['sheets', 'spreadsheets', 'values', 'get',
    '--params', JSON.stringify({ spreadsheetId, range })]);
  return res.values || [];
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const plan = JSON.parse(readFileSync(args.plan, 'utf8'));

  // 1. タブ一覧（sheetId 解決）とテンプレート読み取り
  const meta = gws(['sheets', 'spreadsheets', 'get',
    '--params', JSON.stringify({ spreadsheetId: args.spreadsheet })]);
  const sheetIds = {};
  for (const s of meta.sheets || []) sheetIds[s.properties.title] = s.properties.sheetId;
  const funcMeta = (meta.sheets || []).find((s) => s.properties.title === SHEET_FUNC);
  const columnCount = funcMeta?.properties?.gridProperties?.columnCount || 62;
  console.error(`対象: ${meta.properties?.title}（タブ: ${Object.keys(sheetIds).join(' / ')}、列数: ${columnCount}）`);

  const funcRows = getValues(args.spreadsheet, `'${SHEET_FUNC}'!A1:H200`);
  const overviewRows = getValues(args.spreadsheet, `'${SHEET_OVERVIEW}'!A1:H40`);
  const analysis = analyzeTemplate(funcRows);
  console.error(`テンプレート解析: ヘッダ行=R${analysis.headerRow + 1}, ブロック数=${analysis.blocks.length}, アカウント行=${analysis.accountRows.length}`);

  // 2. 既記入ガード
  const existing = findExistingContent(analysis, funcRows);
  if (existing.length > 0 && !args.force) {
    console.error(`中止: 機能テスト仕様書タブの手順行に既に記入があります（${existing.length}件、例: R${existing[0].row}「${existing[0].value}…」）。`);
    console.error('原本コピー直後の対象か確認してください。上書きする場合は --force を付けてください。');
    process.exit(1);
  }

  // 3. リクエスト生成
  const { structuralRequests, valueData, formatRequests, prodValueData, viewpointRows } =
    buildRequests({ analysis, overviewRows, plan, sheetIds, columnCount });

  if (args.dryRun) {
    console.log(JSON.stringify({ structuralRequests, valueData, formatRequests, prodValueData }, null, 2));
    console.error(`dry-run: 行挿入 ${structuralRequests.length} 件 / 値レンジ ${valueData.length} 件 / 書式系 ${formatRequests.length} 件 / 本番確認上書き ${prodValueData.length} 件（書込は行っていません）`);
    return;
  }

  // 4. 適用（行挿入 → 値 → 結合・本番確認再構成・非表示 → 本番確認の上書き）
  if (structuralRequests.length > 0) {
    gws(['sheets', 'spreadsheets', 'batchUpdate',
      '--params', JSON.stringify({ spreadsheetId: args.spreadsheet })],
      { requests: structuralRequests });
    console.error(`行挿入: ${structuralRequests.length} 件適用`);
  }
  gws(['sheets', 'spreadsheets', 'values', 'batchUpdate',
    '--params', JSON.stringify({ spreadsheetId: args.spreadsheet })],
    { valueInputOption: 'RAW', data: valueData });
  console.error(`値記入: ${valueData.length} レンジ適用`);

  gws(['sheets', 'spreadsheets', 'batchUpdate',
    '--params', JSON.stringify({ spreadsheetId: args.spreadsheet })],
    { requests: formatRequests });
  console.error(`書式系: 観点結合 ${viewpointRows.length} 件＋本番確認タブ再構成＋非表示 適用`);

  if (prodValueData.length > 0) {
    gws(['sheets', 'spreadsheets', 'values', 'batchUpdate',
      '--params', JSON.stringify({ spreadsheetId: args.spreadsheet })],
      { valueInputOption: 'RAW', data: prodValueData });
    console.error(`本番確認タブ上書き: ${prodValueData.length} レンジ適用`);
  }

  // 5. 検算
  if (args.verify) {
    const errors = verify(args.spreadsheet, plan, sheetIds, columnCount);
    if (errors.length > 0) {
      console.error(`検算 NG: ${errors.length} 件の差異`);
      for (const e of errors) console.error(`  - ${e}`);
      process.exit(1);
    }
    console.error('検算 OK: 値・観点結合・罫線・結果欄背景とも plan と一致');
  }

  console.log(`https://docs.google.com/spreadsheets/d/${args.spreadsheet}/edit`);
}

// 記入後の読み戻し検算: 手順 G/H 列の値・観点行の D:E 結合・罫線・結果欄背景を突き合わせる
function verify(spreadsheetId, plan, sheetIds, columnCount) {
  const errors = [];
  const rows = getValues(spreadsheetId, `'${SHEET_FUNC}'!A1:H200`);
  const analysis = analyzeTemplate(rows);
  const { layout, viewpointRows } = buildRequests({
    analysis: { ...analysis, blocks: analysis.blocks }, overviewRows: null, plan, sheetIds, columnCount,
  });

  // 注意: 記入後は行挿入済みのため computeLayout が再度挿入を要求しないこと（容量=記入済み行数）
  for (const b of layout) {
    const title = ((rows[b.headerRow] || [])[2] || '').toString();
    if (title !== b.group.title) errors.push(`R${b.headerRow + 1} 検証内容「${title}」≠「${b.group.title}」`);
    for (const s of b.steps) {
      const g = ((rows[s.row] || [])[6] || '').toString();
      if (g !== s.content) errors.push(`R${s.row + 1} 手順が不一致（先頭: ${g.slice(0, 20)}…）`);
    }
  }

  const meta = gws(['sheets', 'spreadsheets', 'get',
    '--params', JSON.stringify({ spreadsheetId })]);
  const funcSheet = (meta.sheets || []).find((s) => s.properties.title === SHEET_FUNC);
  const merges = (funcSheet?.merges || []).filter((m) => m.startColumnIndex === 3 && m.endColumnIndex === 5);
  for (const r of viewpointRows) {
    if (!merges.some((m) => m.startRowIndex === r && m.endRowIndex === r + 1)) {
      errors.push(`R${r + 1} の検証観点セル D:E 結合がありません`);
    }
  }

  // 罫線・背景検算: 罫線は「有無」ではなく「スタイル＋色」で照合する。
  // テンプレート設計（原本実測）= 黒実線グリッド＋A〜E の横線は透明＋C|D・D|E は灰破線
  // ＋右端2枠は横線のみ。E 列は結合の被覆側で罫線データなしが正常のため検査しない。
  const lastRow = Math.max(...layout.map((b) => b.steps.at(-1)?.row ?? b.headerRow)) + 1;
  // ranges は配列でなくスカラー文字列で渡す（gws のバージョンによって配列が
  // 「Unable to parse range: [...]」になるため。単一レンジならスカラーで互換）
  const grid = gws(['sheets', 'spreadsheets', 'get', '--params', JSON.stringify({
    spreadsheetId, includeGridData: true, ranges: `'${SHEET_FUNC}'!A1:BJ${lastRow}`,
  })]);
  const rowData = grid.sheets?.[0]?.data?.[0]?.rowData || [];
  // 罫線の種別: 黒SOLID（colorStyle.rgbColor あり）／透明SOLID（colorStyle が空）／DASHED／なし
  const kindOf = (r, c, side) => {
    const b = rowData[r]?.values?.[c]?.userEnteredFormat?.borders?.[side];
    if (!b || !b.style || b.style === 'NONE') return 'なし';
    if (b.style !== 'SOLID') return b.style;
    return (b.colorStyle && Object.keys(b.colorStyle).length === 0) ? '透明SOLID' : '黒SOLID';
  };
  const colName = (c) => (c < 26 ? String.fromCharCode(65 + c) : `${String.fromCharCode(64 + Math.floor(c / 26) - 1)}${String.fromCharCode(65 + (c % 26))}`);
  const bgOf = (r, c) => rowData[r]?.values?.[c]?.effectiveFormat?.backgroundColor || {};
  const isGrey = (bg) => Math.abs((bg.red ?? 0) - 0.7176471) < 0.01 && Math.abs((bg.green ?? 0) - 0.7176471) < 0.01;
  const isWhite = (bg) => (bg.red ?? 0) > 0.99 && (bg.green ?? 0) > 0.99 && (bg.blue ?? 0) > 0.99;
  const bj = Math.min(61, columnCount - 1);
  const expect = (r, c, side, want) => {
    const got = kindOf(r, c, side);
    if (got !== want) errors.push(`R${r + 1} ${colName(c)}列の${side}が「${want}」でない（${got}）`);
  };
  layout.forEach((b, blockIndex) => {
    // ブロックを使い切った場合のみ最終手順行の下端が黒（=次見出しの直前）
    const fullyUsed = b.steps.length >= (analysis.blocks[blockIndex]?.stepRows.length ?? 0);
    b.steps.forEach((s, i) => {
      // A 列: 表の外なので全面透明（見出し行の前後にも黒線なし）
      expect(s.row, 0, 'top', '透明SOLID');
      expect(s.row, 0, 'bottom', '透明SOLID');
      expect(s.row, 0, 'left', '透明SOLID');
      // B 列: 内側横線は透明、ブロック上端（見出し直下）は黒、縦線は黒
      expect(s.row, 1, 'top', i === 0 ? '黒SOLID' : '透明SOLID');
      expect(s.row, 1, 'bottom', (i === b.steps.length - 1 && fullyUsed) ? '黒SOLID' : '透明SOLID');
      expect(s.row, 1, 'left', '黒SOLID');
      // F/G/AE 列: 4辺とも黒実線
      for (const c of [5, 6, 30]) {
        for (const side of ['top', 'bottom', 'left', 'right']) expect(s.row, c, side, '黒SOLID');
      }
      // 検証内容の下位区切り（C右・D左）は灰破線
      expect(s.row, 2, 'right', 'DASHED');
      expect(s.row, 3, 'left', 'DASHED');
      // 右端枠（BJ）は横線のみ（上下 黒SOLID）
      expect(s.row, bj, 'top', '黒SOLID');
      expect(s.row, bj, 'bottom', '黒SOLID');
      // 結果欄（H〜BJ）の背景: expected の有無どおり白/灰か（H 列で代表確認）
      const bg = bgOf(s.row, 7);
      if (s.expected ? !isWhite(bg) : !isGrey(bg)) {
        errors.push(`R${s.row + 1} 結果欄の背景が期待と不一致（expected ${s.expected ? 'あり→白' : 'なし→灰'}のはず）`);
      }
      // データ行の C〜H は左揃え（G 列で代表確認。R14 見出し行は対象外）
      const align = rowData[s.row]?.values?.[6]?.userEnteredFormat?.horizontalAlignment;
      if (align !== 'LEFT') {
        errors.push(`R${s.row + 1} G列の水平配置が LEFT でない（${align ?? '未設定'}）`);
      }
      // 「期待する結果」列（H）は折り返し（WRAP）。原本の書式が行ごとに不統一なため明示検査する
      const wrapH = rowData[s.row]?.values?.[7]?.userEnteredFormat?.wrapStrategy;
      if (wrapH !== 'WRAP') {
        errors.push(`R${s.row + 1} H列（期待する結果）の折り返しが WRAP でない（${wrapH ?? '未設定'}）`);
      }
    });
  });

  // 観点セル（D:E 結合）は折り返し（WRAP）
  for (const r of viewpointRows) {
    const wrap = rowData[r]?.values?.[3]?.userEnteredFormat?.wrapStrategy;
    if (wrap !== 'WRAP') {
      errors.push(`観点行 R${r + 1} D列の折り返しが WRAP でない（${wrap ?? '未設定'}）`);
    }
  }
  return errors;
}

// 直接実行時のみ起動（node --test のディレクトリ走査で誤実行されないように）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
