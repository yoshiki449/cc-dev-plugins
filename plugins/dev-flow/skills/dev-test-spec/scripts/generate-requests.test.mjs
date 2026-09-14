import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SHEET_FUNC, SHEET_PROD,
  analyzeTemplate, validatePlan, computeLayout, buildRequests, findExistingContent,
} from './generate-requests.mjs';

// ---- fixture: 原本「機能テスト仕様書」タブの実測構造（2026-07-08）を模す ----
// ヘッダ行 R14（idx13）、ブロック 01〜05（容量 6/5/5/4/6）

function mkTemplate() {
  const rows = [];
  const set = (r, c, v) => {
    rows[r] = rows[r] || [];
    rows[r][c] = v;
  };
  set(1, 1, 'サイトURL'); set(1, 3, 'サンプル人材管理システム');
  for (let r = 2; r <= 6; r++) { set(r, 1, 'ID / Pass'); set(r, 5, '権限'); }
  set(7, 2, '記入例'); set(7, 3, 'https://example.com/sample');
  set(11, 2, '※テストが完了したら…');
  set(13, 1, '検証内容'); set(13, 5, 'No'); set(13, 6, 'テスト内容・手順'); set(13, 7, '期待する結果');
  const blocks = [
    { header: 14, no: '01', steps: 6 },
    { header: 21, no: '02', steps: 5 },
    { header: 27, no: '03', steps: 5 },
    { header: 33, no: '04', steps: 4 },
    { header: 38, no: '05', steps: 6 },
  ];
  for (const b of blocks) {
    set(b.header, 1, b.no);
    for (let i = 0; i < b.steps; i++) set(b.header + 1 + i, 5, String(i + 1).padStart(2, '0'));
  }
  return rows;
}

const SHEET_IDS = {
  [SHEET_FUNC]: 903314754,
  [SHEET_PROD]: 894679392,
  '機能テスト(サマリー)': 736623585,
  '実施概要': 1139263929,
};

function mkOverviewRows() {
  const rows = [];
  rows[2] = ['', '項目', '開発/作成者名', '実施者名', '実施日', 'URL・備考（※3）'];
  rows[3] = ['', '要件定義書', '', 'まるっとのため不要', '-'];
  rows[4] = ['', 'ソース（開発）', '', 'まるっとのため不要', '-'];
  rows[6] = ['', '機能テスト仕様書', '', 'まるっとのため不要', '-'];
  rows[9] = ['', '本番確認テスト仕様書', '', 'まるっとのため不要', '-'];
  return rows;
}

function mkPlan(overrides = {}) {
  return {
    siteUrl: 'https://staging.example.com',
    accounts: [{ idPass: 'test@example.com / password', role: 'テナント管理者', required: '要' }],
    overview: { author: '北村', issueUrl: 'https://github.com/org/repo/issues/1', prUrls: ['https://github.com/org/repo/pull/2'] },
    groups: [
      {
        no: '00', title: '準備',
        cases: [{ viewpoint: '', steps: [{ content: '管理者でログイン' }, { content: 'テストデータを作成' }] }],
      },
      {
        no: '01', title: '帳票出力の確認',
        cases: [
          { viewpoint: '出力データの登録', steps: [{ content: 'タブを押下する' }] },
          { viewpoint: 'デフォルト値の帳票検証', steps: [{ content: '面談結果を追加する', expected: '' }, { content: '帳票出力して確認', expected: '内容が反映されている' }] },
        ],
      },
    ],
    hideTabs: ['機能テスト(サマリー)'],
    ...overrides,
  };
}

// ---- analyzeTemplate ----

test('analyzeTemplate: ヘッダ行・アカウント行・ブロック構造を検出する', () => {
  const a = analyzeTemplate(mkTemplate());
  assert.equal(a.headerRow, 13);
  assert.equal(a.siteUrlRow, 1);
  assert.deepEqual(a.accountRows, [2, 3, 4, 5, 6]);
  assert.equal(a.blocks.length, 5);
  assert.deepEqual(a.blocks.map((b) => b.stepRows.length), [6, 5, 5, 4, 6]);
  assert.equal(a.blocks[0].headerRow, 14);
  assert.deepEqual(a.blocks[1].stepRows, [22, 23, 24, 25, 26]);
});

test('analyzeTemplate: ヘッダ行がなければ throw', () => {
  assert.throws(() => analyzeTemplate([['x']]), /ヘッダ行/);
});

// ---- validatePlan ----

test('validatePlan: groups 空 / title 欠落 / steps 空を弾く', () => {
  assert.throws(() => validatePlan({ groups: [] }), /groups が空/);
  assert.throws(() => validatePlan({ groups: [{ cases: [{ steps: [{ content: 'x' }] }] }] }), /title は必須/);
  assert.throws(() => validatePlan({ groups: [{ title: 'A', cases: [{ steps: [] }] }] }), /steps がありません/);
  assert.throws(() => validatePlan({ groups: [{ title: 'A', cases: [{ steps: [{}] }] }] }), /content 空/);
});

// ---- computeLayout ----

test('computeLayout: 容量内なら挿入なし・連番・観点はケース先頭行のみ', () => {
  const a = analyzeTemplate(mkTemplate());
  const { inserts, layout } = computeLayout(a, mkPlan().groups);
  assert.equal(inserts.length, 0);
  // グループ0 = ブロック0（ヘッダ idx14、手順 idx15〜）
  assert.equal(layout[0].headerRow, 14);
  assert.deepEqual(layout[0].steps.map((s) => s.row), [15, 16]);
  assert.deepEqual(layout[0].steps.map((s) => s.num), ['01', '02']);
  // グループ1 = ブロック1: ケース2つ、連番は 01/02/03、観点は各ケース先頭のみ
  assert.deepEqual(layout[1].steps.map((s) => s.num), ['01', '02', '03']);
  assert.deepEqual(layout[1].steps.map((s) => s.viewpoint), ['出力データの登録', 'デフォルト値の帳票検証', null]);
  // グループ0 の観点は空文字 → 観点なし扱い
  assert.deepEqual(layout[0].steps.map((s) => s.viewpoint), [null, null]);
});

test('computeLayout: 容量超過分は行挿入し、後続ブロックの座標をずらす', () => {
  const a = analyzeTemplate(mkTemplate());
  const groups = [
    { no: '00', title: 'A', cases: [{ viewpoint: '', steps: Array.from({ length: 8 }, (_, i) => ({ content: `s${i}` })) }] },
    { no: '01', title: 'B', cases: [{ viewpoint: 'v', steps: [{ content: 'x' }] }] },
  ];
  const { inserts, layout } = computeLayout(a, groups);
  // ブロック0 容量6 に 8 手順 → 末尾手順行 idx20 の直後(21)に 2 行挿入
  assert.deepEqual(inserts, [{ atRow: 21, count: 2 }]);
  assert.deepEqual(layout[0].steps.map((s) => s.row), [15, 16, 17, 18, 19, 20, 21, 22]);
  // ブロック1 は 2 行下にずれる
  assert.equal(layout[1].headerRow, 23);
  assert.deepEqual(layout[1].steps.map((s) => s.row), [24]);
});

test('computeLayout: グループ数がブロック数を超えたら throw', () => {
  const a = analyzeTemplate(mkTemplate());
  const groups = Array.from({ length: 6 }, (_, i) => ({
    no: String(i), title: `g${i}`, cases: [{ steps: [{ content: 'x' }] }],
  }));
  assert.throws(() => computeLayout(a, groups), /ブロック数 5 を超えています/);
});

// ---- buildRequests ----

function build(planOverrides = {}) {
  const a = analyzeTemplate(mkTemplate());
  return buildRequests({
    analysis: a, overviewRows: mkOverviewRows(), plan: mkPlan(planOverrides), sheetIds: SHEET_IDS,
  });
}

test('buildRequests: 値レンジ（サイトURL・アカウント・ブロック見出し・手順）を生成する', () => {
  const { valueData } = build();
  const ranges = valueData.map((v) => v.range);
  assert.ok(ranges.includes(`'${SHEET_FUNC}'!D2`)); // サイトURL（idx1 → R2）
  assert.ok(ranges.includes(`'${SHEET_FUNC}'!D3`)); // アカウント1（idx2 → R3）
  assert.ok(ranges.includes(`'${SHEET_FUNC}'!B15:C15`)); // ブロック0 見出し
  const header = valueData.find((v) => v.range === `'${SHEET_FUNC}'!B15:C15`);
  assert.deepEqual(header.values, [['00', '準備']]);
  // グループ1 ケース1先頭（idx22 → R23）は観点付き D:H
  const vp = valueData.find((v) => v.range === `'${SHEET_FUNC}'!D23:H23`);
  assert.deepEqual(vp.values, [['出力データの登録', '', '01', 'タブを押下する', '']]);
  // 観点なし行（グループ0 は観点が空文字）は F:H
  const st = valueData.find((v) => v.range === `'${SHEET_FUNC}'!F16:H16`);
  assert.deepEqual(st.values, [['01', '管理者でログイン', '']]);
  const st2 = valueData.find((v) => v.range === `'${SHEET_FUNC}'!F17:H17`);
  assert.deepEqual(st2.values, [['02', 'テストデータを作成', '']]);
});

test('buildRequests: 実施概要は項目名で行を特定して C 列と F 列に書く', () => {
  const { valueData } = build();
  const byRange = Object.fromEntries(valueData.map((v) => [v.range, v.values]));
  assert.deepEqual(byRange[`'実施概要'!C4`], [['北村']]); // 要件定義書（idx3 → R4）
  assert.deepEqual(byRange[`'実施概要'!F4`], [['https://github.com/org/repo/issues/1']]);
  assert.deepEqual(byRange[`'実施概要'!F5`], [['https://github.com/org/repo/pull/2']]);
  assert.deepEqual(byRange[`'実施概要'!C10`], [['北村']]); // 本番確認テスト仕様書（idx9 → R10）
});

test('buildRequests: 観点行ごとに D:E の MERGE_ALL を生成する', () => {
  const { formatRequests, viewpointRows } = build();
  // グループ0 は観点空 → 対象外。グループ1 のケース先頭 idx22, idx23 のみ
  assert.deepEqual(viewpointRows, [22, 23]);
  const merges = formatRequests.filter((r) => r.mergeCells);
  assert.equal(merges.length, 2);
  assert.deepEqual(merges[0].mergeCells.range, {
    sheetId: 903314754, startRowIndex: 22, endRowIndex: 23, startColumnIndex: 3, endColumnIndex: 5,
  });
  assert.equal(merges[0].mergeCells.mergeType, 'MERGE_ALL');
});

test('buildRequests: 手順行をテンプレート設計どおりにスライス塗装する（黒grid＋A〜E横線透明＋灰破線＋右端横線のみ）', () => {
  const { formatRequests } = build();
  const borderReqs = formatRequests.filter((r) => r.updateBorders);
  // 使用ブロック2 × 6スライス（黒grid / A列透明 / B〜E横線透明 / 灰破線 / 右端枠×2）
  assert.equal(borderReqs.length, 12);

  // ブロック0 の黒grid: 手順行 idx15〜16、B〜AX（A列と末尾12列を除く）
  const grid0 = borderReqs[0].updateBorders;
  assert.deepEqual(grid0.range, {
    sheetId: 903314754, startRowIndex: 15, endRowIndex: 17, startColumnIndex: 1, endColumnIndex: 50,
  });
  for (const side of ['top', 'bottom', 'left', 'right', 'innerHorizontal', 'innerVertical']) {
    assert.equal(grid0[side].style, 'SOLID', side);
    assert.deepEqual(grid0[side].colorStyle, { rgbColor: {} }, `${side} は黒`);
  }

  // A 列は全面透明（見出し行の前後にも黒線なし）。right は B の left（表の左端線）
  // との共有辺なので触らない
  const colA0 = borderReqs[1].updateBorders;
  assert.deepEqual(colA0.range, {
    sheetId: 903314754, startRowIndex: 15, endRowIndex: 17, startColumnIndex: 0, endColumnIndex: 1,
  });
  for (const side of ['top', 'bottom', 'left', 'innerHorizontal']) {
    assert.equal(colA0[side].style, 'SOLID', side);
    assert.deepEqual(colA0[side].colorStyle, {}, `${side} は透明`);
  }
  assert.equal(colA0.right, undefined, 'A の right（=B の left 黒）は触らない');

  // B〜E の内側横線だけ透明（colorStyle:{} を明示。省略すると黒になる）。
  // ブロック上端＝見出し行直下の黒線は黒グリッドのまま残す
  const clear0 = borderReqs[2].updateBorders;
  assert.deepEqual(clear0.range, {
    sheetId: 903314754, startRowIndex: 15, endRowIndex: 17, startColumnIndex: 1, endColumnIndex: 5,
  });
  assert.equal(clear0.innerHorizontal.style, 'SOLID');
  assert.deepEqual(clear0.innerHorizontal.colorStyle, {}, 'innerHorizontal は透明（色指定なし）');
  assert.equal(clear0.top, undefined, 'ブロック上端（見出し直下の黒線）は触らない');
  // ブロック0 は容量6に2手順＝使い切っていない → 下端はブロック途中なので透明に戻す
  assert.deepEqual(clear0.bottom.colorStyle, {}, '部分使用ブロックの下端は透明');
  assert.equal(clear0.innerVertical, undefined, '透明スライスは縦線を触らない');
  assert.equal(clear0.left, undefined);

  // C〜E の内側縦線は灰破線
  const dash0 = borderReqs[3].updateBorders;
  assert.deepEqual(dash0.range, {
    sheetId: 903314754, startRowIndex: 15, endRowIndex: 17, startColumnIndex: 2, endColumnIndex: 5,
  });
  assert.equal(dash0.innerVertical.style, 'DASHED');
  assert.ok(Math.abs(dash0.innerVertical.colorStyle.rgbColor.red - 0.7529412) < 0.001);
  assert.equal(dash0.top, undefined, '破線スライスは縦線以外を触らない');

  // 右端2枠: 横線＋左端のみ（内側縦線・右端線なし）
  const far0 = borderReqs[4].updateBorders;
  assert.deepEqual(far0.range, {
    sheetId: 903314754, startRowIndex: 15, endRowIndex: 17, startColumnIndex: 50, endColumnIndex: 56,
  });
  assert.equal(far0.innerHorizontal.style, 'SOLID');
  assert.equal(far0.left.style, 'SOLID');
  assert.equal(far0.innerVertical, undefined);
  assert.equal(far0.right, undefined);
  assert.equal(borderReqs[5].updateBorders.range.startColumnIndex, 56);

  // 塗装 → 結合の順（結合が E を空にするのはサンプルと同じ正常状態）
  const kinds = formatRequests.map((r) => Object.keys(r)[0]);
  assert.ok(kinds.indexOf('mergeCells') > kinds.indexOf('updateBorders'));
});

test('buildRequests: 挿入行も塗装範囲に含まれ、ブロック見出し行は触らない', () => {
  // ブロック0（容量6）に 8 手順 → 手順行 idx15〜22（挿入2行含む）が塗装範囲
  const groups = [
    { no: '00', title: 'A', cases: [{ steps: Array.from({ length: 8 }, (_, i) => ({ content: `a${i}` })) }] },
  ];
  const { formatRequests } = build({ groups });
  const grid = formatRequests.find((r) => r.updateBorders).updateBorders;
  assert.deepEqual(grid.range, {
    sheetId: 903314754, startRowIndex: 15, endRowIndex: 23, startColumnIndex: 1, endColumnIndex: 50,
  });
  // 見出し行（idx14）は塗装しない（テンプレートの書式を保持）
  for (const r of formatRequests.filter((x) => x.updateBorders)) {
    assert.ok(r.updateBorders.range.startRowIndex >= 15);
  }
  // 容量6に8手順＝使い切った（挿入あり）→ 下端は次見出し直前なので黒のまま（bottom を触らない）
  const clear = formatRequests.filter((x) => x.updateBorders)[2].updateBorders;
  assert.equal(clear.bottom, undefined, '使い切ったブロックの下端は黒グリッドを残す');
});

test('buildRequests: 観点結合セルは折り返し（WRAP）を設定する', () => {
  const { formatRequests, viewpointRows } = build();
  const kindsAt = formatRequests.map((r) => Object.keys(r)[0]);
  // H 列（期待する結果）にも別途 WRAP を出すので、観点セル（D 列始まり）だけに絞って数える
  const wraps = formatRequests.filter((r) => r.repeatCell?.fields === 'userEnteredFormat.wrapStrategy'
    && r.repeatCell.range.startColumnIndex === 3);
  assert.equal(wraps.length, viewpointRows.length, '観点行ごとに WRAP 設定があるべき');
  const mergeIdx = kindsAt.indexOf('mergeCells');
  const wrap0 = formatRequests[mergeIdx + 1].repeatCell;
  assert.ok(wrap0, 'mergeCells の直後に WRAP の repeatCell があるべき');
  assert.deepEqual(wrap0.range, formatRequests[mergeIdx].mergeCells.range, '結合と同じレンジ');
  assert.equal(wrap0.cell.userEnteredFormat.wrapStrategy, 'WRAP');
});

test('buildRequests: H 列（期待する結果）のデータ行を両タブとも折り返しにする', () => {
  const { formatRequests } = build();
  const wrapsH = formatRequests.filter((r) => r.repeatCell?.fields === 'userEnteredFormat.wrapStrategy'
    && r.repeatCell.range.startColumnIndex === 7);
  assert.equal(wrapsH.length, 2, '機能テスト・本番確認の両タブ分');
  for (const w of wrapsH) {
    assert.equal(w.repeatCell.range.startRowIndex, 14, 'ヘッダ行 idx13 の1つ下から');
    assert.equal(w.repeatCell.range.endColumnIndex, 8, 'H 列だけ（G は原本が全行 WRAP なので触らない）');
    assert.equal(w.repeatCell.cell.userEnteredFormat.wrapStrategy, 'WRAP');
  }
  assert.deepEqual(wrapsH.map((w) => w.repeatCell.range.sheetId).sort(), [894679392, 903314754]);
  // 本番確認側は copyPaste で上書きされるため、必ず copyPaste より後に当てる
  const idxOf = (pred) => formatRequests.findIndex(pred);
  const copyIdx = idxOf((r) => r.copyPaste);
  const isWrapH = (sheetId) => (r) => r.repeatCell?.fields === 'userEnteredFormat.wrapStrategy'
    && r.repeatCell.range.startColumnIndex === 7 && r.repeatCell.range.sheetId === sheetId;
  assert.ok(idxOf(isWrapH(903314754)) < copyIdx, '機能テスト側は copyPaste より前');
  assert.ok(idxOf(isWrapH(894679392)) > copyIdx, '本番確認側は copyPaste より後');
});

test('buildRequests: C〜H のデータ行（R14 見出しの下〜末尾）を両タブとも左揃えにする', () => {
  const { formatRequests } = build();
  const aligns = formatRequests.filter((r) => r.repeatCell?.fields === 'userEnteredFormat.horizontalAlignment');
  assert.equal(aligns.length, 2, '機能テスト・本番確認の両タブ分');
  for (const a of aligns) {
    assert.equal(a.repeatCell.range.startRowIndex, 14, 'ヘッダ行 idx13 の1つ下から');
    assert.equal(a.repeatCell.range.startColumnIndex, 2); // C 列
    assert.equal(a.repeatCell.range.endColumnIndex, 8); // H 列まで
    assert.equal(a.repeatCell.cell.userEnteredFormat.horizontalAlignment, 'LEFT');
  }
  assert.deepEqual(aligns.map((a) => a.repeatCell.range.sheetId).sort(), [894679392, 903314754]);
  // 機能テスト側の左揃えは copyPaste より前、本番確認側は copyPaste より後
  const idxOf = (pred) => formatRequests.findIndex(pred);
  const copyIdx = idxOf((r) => r.copyPaste);
  const funcAlignIdx = idxOf((r) => r.repeatCell?.fields === 'userEnteredFormat.horizontalAlignment' && r.repeatCell.range.sheetId === 903314754);
  const prodAlignIdx = idxOf((r) => r.repeatCell?.fields === 'userEnteredFormat.horizontalAlignment' && r.repeatCell.range.sheetId === 894679392);
  assert.ok(funcAlignIdx < copyIdx && copyIdx < prodAlignIdx, `順序不正: func=${funcAlignIdx} copy=${copyIdx} prod=${prodAlignIdx}`);
});

test('buildRequests: 結果欄 H:BJ は expected の有無で灰/白に塗り分ける', () => {
  const { formatRequests } = build();
  const fills = formatRequests.filter((r) => r.repeatCell?.fields === 'userEnteredFormat.backgroundColor');
  // 全手順行分（グループ0: 2手順、グループ1: 3手順）
  assert.equal(fills.length, 5);
  for (const f of fills) {
    assert.equal(f.repeatCell.range.startColumnIndex, 7); // H 列
    assert.equal(f.repeatCell.range.endColumnIndex, 62); // BJ 列まで
    assert.equal(f.repeatCell.fields, 'userEnteredFormat.backgroundColor');
  }
  // グループ1 の 3 手順目（idx24 → expected あり）だけ白、他は灰
  const byRow = Object.fromEntries(fills.map((f) => [f.repeatCell.range.startRowIndex, f.repeatCell.cell.userEnteredFormat.backgroundColor]));
  assert.equal(byRow[24].red, 1, 'expected あり → 白');
  assert.ok(Math.abs(byRow[15].red - 0.7176471) < 0.001, 'expected なし → 灰');
  assert.ok(Math.abs(byRow[22].red - 0.7176471) < 0.001, 'expected なし → 灰');
});

test('buildRequests: 罫線復元は本番確認タブの copyPaste より前に入る', () => {
  const groups = [
    { no: '00', title: 'A', cases: [{ viewpoint: 'v', steps: Array.from({ length: 8 }, (_, i) => ({ content: `a${i}` })) }] },
  ];
  const { formatRequests } = build({ groups });
  const kinds = formatRequests.map((r) => Object.keys(r)[0]);
  const lastBorder = kinds.lastIndexOf('updateBorders');
  const copy = kinds.indexOf('copyPaste');
  assert.ok(lastBorder >= 0 && copy > lastBorder, `copyPaste は罫線復元の後であるべき: ${kinds}`);
});

test('buildRequests: 行挿入は降順で生成される', () => {
  const groups = [
    { no: '00', title: 'A', cases: [{ steps: Array.from({ length: 8 }, (_, i) => ({ content: `a${i}` })) }] },
    { no: '01', title: 'B', cases: [{ steps: Array.from({ length: 7 }, (_, i) => ({ content: `b${i}` })) }] },
  ];
  const { structuralRequests } = build({ groups });
  assert.equal(structuralRequests.length, 2);
  const starts = structuralRequests.map((r) => r.insertDimension.range.startIndex);
  assert.ok(starts[0] > starts[1], `降順であるべき: ${starts}`);
  assert.equal(structuralRequests[0].insertDimension.inheritFromBefore, true);
});

test('buildRequests: 本番確認タブは unmerge → clear → copyPaste の順で再構成する', () => {
  const { formatRequests } = build();
  const kinds = formatRequests.map((r) => Object.keys(r)[0]);
  const iUn = kinds.indexOf('unmergeCells');
  const iClear = kinds.indexOf('updateCells');
  const iCopy = kinds.indexOf('copyPaste');
  assert.ok(iUn >= 0 && iClear > iUn && iCopy > iClear, `順序不正: ${kinds}`);
  const cp = formatRequests[iCopy].copyPaste;
  assert.equal(cp.source.sheetId, 903314754);
  assert.equal(cp.destination.sheetId, 894679392);
  // 末尾ブロック（idx38+6手順=idx44）まで含む
  assert.ok(cp.source.endRowIndex >= 45, `copy範囲が浅い: ${cp.source.endRowIndex}`);
  // 全62列（A〜BJ、Z超のブラウザ別結果欄を含む）をコピーする
  assert.equal(cp.source.endColumnIndex, 62);
  assert.equal(cp.destination.endColumnIndex, 62);
});

test('buildRequests: 行挿入があると copyPaste 範囲も挿入分だけ伸びる', () => {
  const groups = [
    { no: '00', title: 'A', cases: [{ steps: Array.from({ length: 16 }, (_, i) => ({ content: `a${i}` })) }] },
  ];
  const { formatRequests } = build({ groups });
  const cp = formatRequests.find((r) => r.copyPaste).copyPaste;
  // 挿入10行分、未使用の末尾ブロック（idx44）が idx54 までずれる
  assert.ok(cp.source.endRowIndex >= 55, `挿入分が未反映: ${cp.source.endRowIndex}`);
});

test('buildRequests: hideTabs の非表示リクエストと未知タブの throw', () => {
  const { formatRequests } = build();
  const hide = formatRequests.find((r) => r.updateSheetProperties);
  assert.equal(hide.updateSheetProperties.properties.sheetId, 736623585);
  assert.equal(hide.updateSheetProperties.properties.hidden, true);
  assert.throws(() => build({ hideTabs: ['存在しないタブ'] }), /見つかりません/);
});

test('buildRequests: 本番確認の URL/アカウント上書きは prodValueData に分離される', () => {
  const { prodValueData } = build({
    prodSiteUrl: 'https://prod.example.com',
    prodAccounts: [{ idPass: 'prod@example.com / pw', role: '管理者', required: '要' }],
  });
  const byRange = Object.fromEntries(prodValueData.map((v) => [v.range, v.values]));
  assert.deepEqual(byRange[`'${SHEET_PROD}'!D2`], [['https://prod.example.com']]);
  assert.deepEqual(byRange[`'${SHEET_PROD}'!G3:H3`], [['管理者', '要']]);
});

test('buildRequests: prod 指定なしなら prodValueData は空（コピー元の値を維持）', () => {
  const { prodValueData } = build();
  assert.equal(prodValueData.length, 0);
});

test('buildRequests: アカウント数がテンプレート行数を超えたら throw', () => {
  const accounts = Array.from({ length: 6 }, (_, i) => ({ idPass: `u${i}` }));
  assert.throws(() => build({ accounts }), /アカウント数 6 が/);
});

// ---- findExistingContent ----

test('findExistingContent: 手順行 G 列の既記入を検出する', () => {
  const rows = mkTemplate();
  const a = analyzeTemplate(rows);
  assert.deepEqual(findExistingContent(a, rows), []);
  rows[22][6] = '既に書かれた手順';
  const found = findExistingContent(a, rows);
  assert.equal(found.length, 1);
  assert.equal(found[0].row, 23); // 1-based
});
