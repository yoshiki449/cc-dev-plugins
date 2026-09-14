// dev-test-spec: テスト計画 JSON → Sheets API リクエスト生成（純関数モジュール）
//
// 社内規定のテスト仕様書スプレッドシート（原本_【人材管理】総合テスト仕様書）を
// Drive コピーした後、このモジュールが生成するリクエストで値記入・セル結合・
// 行挿入・タブ非表示を行う。書式・背景色・既存結合は原本コピーで保持済みのため、
// ここで扱うのは「記入に伴う差分」のみ。
//
// タブ構成の前提（実測 2026-07-08、原本 1AQU4HplC2LxrKfPQ2-ZTGP2JuLfa3yn6SVYb9UsS75o）:
//   機能テスト仕様書: R2=サイトURL(D列) / R3-R7=アカウント表(D=ID/Pass, G=権限, H=要否)
//     R14=ヘッダ(B=検証内容, F=No, G=テスト内容・手順, H=期待する結果)
//     R15以降=大項目ブロック(B=大項目No, C=検証内容タイトル, D:E結合=検証観点, F=手順No)
//   本番確認テスト仕様書: 機能テスト仕様書の全範囲コピーで再構成する（サンプル実測より）
//   実施概要: B列=項目名, C=開発/作成者名, F=URL・備考
//
// 座標はすべて 0-based（GridRange）。values API 用レンジのみ A1 記法に変換する。

export const SHEET_FUNC = '機能テスト仕様書';
export const SHEET_PROD = '本番確認テスト仕様書';
export const SHEET_OVERVIEW = '実施概要';

// ---- 内部ヘルパ ----

const cell = (rows, r, c) => ((rows[r] || [])[c] || '').toString().trim();

const a1Row = (r0) => r0 + 1; // 0-based → 1-based

function quoteSheet(name) {
  return `'${name.replace(/'/g, "''")}'`;
}

const pad2 = (n) => String(n).padStart(2, '0');

// ---- テンプレート解析 ----

// values get の結果（string[][]）から機能テスト仕様書タブの構造を割り出す。
// 行番号ハードコードを避け、原本のマイナー改版に追従する。
export function analyzeTemplate(rows) {
  const analysis = { siteUrlRow: -1, accountRows: [], headerRow: -1, blocks: [] };

  for (let r = 0; r < rows.length; r++) {
    const b = cell(rows, r, 1);
    if (b === 'サイトURL' && analysis.siteUrlRow < 0) analysis.siteUrlRow = r;
    if (b === 'ID / Pass') analysis.accountRows.push(r);
    if (b === '検証内容' && cell(rows, r, 5) === 'No') {
      analysis.headerRow = r;
      break;
    }
  }
  if (analysis.headerRow < 0) {
    throw new Error(`テンプレート解析失敗: ヘッダ行（B=検証内容, F=No）が見つかりません。原本の構造が変わった可能性があります`);
  }

  // ヘッダ行の下: B列非空=ブロック見出し行、F列非空=手順行、両方空=ブロック領域終端
  let current = null;
  for (let r = analysis.headerRow + 1; r < rows.length; r++) {
    const b = cell(rows, r, 1);
    const f = cell(rows, r, 5);
    if (b !== '') {
      current = { headerRow: r, templateNo: b, stepRows: [] };
      analysis.blocks.push(current);
    } else if (f !== '' && current) {
      current.stepRows.push(r);
    } else {
      break;
    }
  }
  if (analysis.blocks.length === 0) {
    throw new Error('テンプレート解析失敗: 大項目ブロックが1つも見つかりません');
  }
  return analysis;
}

// ---- 検証計画の正規化 ----

export function validatePlan(plan) {
  if (!plan || typeof plan !== 'object') throw new Error('plan が JSON オブジェクトではありません');
  if (!Array.isArray(plan.groups) || plan.groups.length === 0) {
    throw new Error('plan.groups が空です。手動テストの大項目を1つ以上定義してください');
  }
  for (const g of plan.groups) {
    if (!g.title) throw new Error(`groups[].title は必須です（no=${g.no ?? '?'}）`);
    if (!Array.isArray(g.cases) || g.cases.length === 0) {
      throw new Error(`グループ「${g.title}」に cases がありません`);
    }
    for (const c of g.cases) {
      if (!Array.isArray(c.steps) || c.steps.length === 0) {
        throw new Error(`グループ「${g.title}」の検証観点「${c.viewpoint ?? ''}」に steps がありません`);
      }
      for (const s of c.steps) {
        if (!s.content) throw new Error(`グループ「${g.title}」に content 空の手順があります`);
      }
    }
  }
  return plan;
}

// ---- レイアウト計算（行挿入を織り込んだ最終座標）----

// 各グループを i 番目のテンプレートブロックに割り当て、手順数が容量を超える分の
// 行挿入と、挿入後の最終行座標を計算する。
export function computeLayout(analysis, groups) {
  if (groups.length > analysis.blocks.length) {
    throw new Error(
      `グループ数 ${groups.length} がテンプレートのブロック数 ${analysis.blocks.length} を超えています。` +
      `グループを統合するか、原本にブロックを追加してください`
    );
  }

  const inserts = []; // { atRow(挿入前の0-based行), count } 元座標基準
  const layout = []; // { group, headerRow, steps: [{row, num, content, expected, viewpoint?}] } 挿入後座標
  let offset = 0;

  groups.forEach((group, i) => {
    const block = analysis.blocks[i];
    const flatSteps = [];
    let num = 0;
    for (const c of group.cases) {
      c.steps.forEach((s, j) => {
        num += 1;
        flatSteps.push({
          num: pad2(num),
          content: s.content,
          expected: s.expected || '',
          // 観点は各ケース先頭行のみ。空観点は観点なし（D書込・結合とも行わない）
          viewpoint: (j === 0 && c.viewpoint) ? c.viewpoint : null,
        });
      });
    }

    const capacity = block.stepRows.length;
    const need = flatSteps.length;
    if (need > capacity) {
      // ブロック末尾の手順行の直後に不足分を挿入（書式は直前行から継承）
      inserts.push({ atRow: block.stepRows[capacity - 1] + 1, count: need - capacity });
    }

    const headerRow = block.headerRow + offset;
    const firstStepRow = block.stepRows[0] + offset;
    layout.push({
      group,
      headerRow,
      steps: flatSteps.map((s, k) => ({ ...s, row: firstStepRow + k })),
    });

    if (need > capacity) offset += need - capacity;
  });

  return { inserts, layout };
}

// ---- リクエスト生成 ----

// 戻り値は API 呼び出し順に4分割:
//   structuralRequests: batchUpdate #1（行挿入。元座標基準・降順で安全に適用）
//   valueData:          values batchUpdate #1（機能テスト＋実施概要、RAW）
//   formatRequests:     batchUpdate #2（機能テスト観点結合 → 本番確認再構成 → タブ非表示）
//   prodValueData:      values batchUpdate #2（本番確認のURL/アカウント差し替え）
export function buildRequests({ analysis, overviewRows, plan, sheetIds, columnCount = 62 }) {
  validatePlan(plan);
  const funcId = sheetIds[SHEET_FUNC];
  const prodId = sheetIds[SHEET_PROD];
  if (funcId == null) throw new Error(`シート「${SHEET_FUNC}」が見つかりません`);
  if (prodId == null) throw new Error(`シート「${SHEET_PROD}」が見つかりません`);

  const { inserts, layout } = computeLayout(analysis, plan.groups);

  // --- batchUpdate #1: 行挿入（降順で適用すれば前方の元座標がずれない）---
  const structuralRequests = [...inserts]
    .sort((a, b) => b.atRow - a.atRow)
    .map(({ atRow, count }) => ({
      insertDimension: {
        range: { sheetId: funcId, dimension: 'ROWS', startIndex: atRow, endIndex: atRow + count },
        inheritFromBefore: true,
      },
    }));

  // --- values #1: 機能テスト仕様書 ---
  const q = quoteSheet(SHEET_FUNC);
  const valueData = [];

  if (plan.siteUrl) {
    valueData.push({ range: `${q}!D${a1Row(analysis.siteUrlRow)}`, values: [[plan.siteUrl]] });
  }
  (plan.accounts || []).forEach((acc, i) => {
    const r = analysis.accountRows[i];
    if (r == null) throw new Error(`アカウント数 ${plan.accounts.length} がテンプレートの行数 ${analysis.accountRows.length} を超えています`);
    valueData.push({
      range: `${q}!D${a1Row(r)}`, values: [[acc.idPass || '']],
    });
    valueData.push({
      range: `${q}!G${a1Row(r)}:H${a1Row(r)}`, values: [[acc.role || '', acc.required || '']],
    });
  });

  const viewpointRows = [];
  for (const b of layout) {
    valueData.push({
      range: `${q}!B${a1Row(b.headerRow)}:C${a1Row(b.headerRow)}`,
      values: [[b.group.no ?? '', b.group.title]],
    });
    for (const s of b.steps) {
      if (s.viewpoint !== null) {
        viewpointRows.push(s.row);
        valueData.push({
          range: `${q}!D${a1Row(s.row)}:H${a1Row(s.row)}`,
          values: [[s.viewpoint, '', s.num, s.content, s.expected]],
        });
      } else {
        valueData.push({
          range: `${q}!F${a1Row(s.row)}:H${a1Row(s.row)}`,
          values: [[s.num, s.content, s.expected]],
        });
      }
    }
  }

  // --- values #1: 実施概要（B列の項目名で行を特定。C=作成者, F=URL・備考のみ書く）---
  if (plan.overview && overviewRows) {
    const ov = plan.overview;
    const findRow = (label) => overviewRows.findIndex((row) => ((row || [])[1] || '').toString().trim() === label);
    const oq = quoteSheet(SHEET_OVERVIEW);
    const authorTargets = ['要件定義書', 'ソース（開発）', '機能テスト仕様書', '本番確認テスト仕様書'];
    for (const label of authorTargets) {
      const r = findRow(label);
      if (r >= 0 && ov.author) valueData.push({ range: `${oq}!C${a1Row(r)}`, values: [[ov.author]] });
    }
    const reqRow = findRow('要件定義書');
    if (reqRow >= 0 && ov.issueUrl) valueData.push({ range: `${oq}!F${a1Row(reqRow)}`, values: [[ov.issueUrl]] });
    const srcRow = findRow('ソース（開発）');
    if (srcRow >= 0 && Array.isArray(ov.prUrls) && ov.prUrls.length > 0) {
      valueData.push({ range: `${oq}!F${a1Row(srcRow)}`, values: [[ov.prUrls.join('\n')]] });
    }
  }

  // --- batchUpdate #2: 罫線塗装 → 観点セル結合 → 結果欄塗り分け → 本番確認タブ再構成 → タブ非表示 ---
  const formatRequests = [];
  const colCount = columnCount; // 原本実測: 62（A〜BJ。ブラウザ別結果欄が Z を超えて続く）

  // 罫線の設計（原本テンプレート実測 2026-07-08、userEnteredFormat.borders）:
  //   - 手順行の基本は SOLID 幅1 黒の全面グリッド
  //   - ただし A〜E 列の「横線」は透明（colorStyle:{} = 色指定なし SOLID。見出し行の
  //     前後の黒横線は見出し行自身の上下罫線が持つため、手順行側はすべて透明）
  //   - C|D・D|E の内側縦線だけは DASHED 幅1 灰(0.753) —「検証内容」下位領域の区切り
  //   - 右端2ブラウザ枠（末尾12列 = AY〜BD / BE〜BJ）は横線＋枠左端のみで内側縦線なし
  //   - ブロック見出し行はテンプレートのまま触らない（値しか書かないので書式は壊れない）
  // insertDimension は罫線を継承せず、一律黒塗りは破線・透明の設計を壊すため
  // （v0.20.2〜v0.20.3 の障害）、このスライス塗装でテンプレートと同一の設計に揃える。
  // 注意: colorStyle を省略すると黒にフォールバックする（実験で確認）。透明は {} を明示する。
  const SOLID_BLACK = { style: 'SOLID', width: 1, colorStyle: { rgbColor: {} } };
  const SOLID_CLEAR = { style: 'SOLID', width: 1, colorStyle: {} };
  const DASHED_GREY = { style: 'DASHED', width: 1, colorStyle: { rgbColor: { red: 0.7529412, green: 0.7529412, blue: 0.7529412 } } };
  const FULL_GRID_END = colCount - 12; // ここから右は横線のみの2枠（各6列）
  layout.forEach((b, blockIndex) => {
    if (b.steps.length === 0) return;
    const r0 = b.steps[0].row;
    const r1 = b.steps[b.steps.length - 1].row + 1;
    // ブロックの手順行を使い切ったか（未使用のテンプレート手順行が下に残るか）
    const fullyUsed = b.steps.length >= analysis.blocks[blockIndex].stepRows.length;
    // (1) B〜AX: 黒の全面グリッド（A 列は表の外なので塗らない。表の左端線は B の left が持つ）
    formatRequests.push({
      updateBorders: {
        range: { sheetId: funcId, startRowIndex: r0, endRowIndex: r1, startColumnIndex: 1, endColumnIndex: FULL_GRID_END },
        top: SOLID_BLACK, bottom: SOLID_BLACK, left: SOLID_BLACK, right: SOLID_BLACK,
        innerHorizontal: SOLID_BLACK, innerVertical: SOLID_BLACK,
      },
    });
    // (2) A 列は全面透明（原本実測: 見出し行の前後も含め A 列に黒線はない）。
    //     right は B の left（黒・表の左端線）との共有辺のため触らない（上書きすると消える）
    formatRequests.push({
      updateBorders: {
        range: { sheetId: funcId, startRowIndex: r0, endRowIndex: r1, startColumnIndex: 0, endColumnIndex: 1 },
        top: SOLID_CLEAR, bottom: SOLID_CLEAR, left: SOLID_CLEAR, innerHorizontal: SOLID_CLEAR,
      },
    });
    // (3) B〜E の「内側」横線だけ透明に差し替え（黒横線は見出し行の前後のみ、の仕様）
    //     ブロック上端（=見出し行直下の黒線）は (1) の黒グリッドを残す。
    //     下端は、ブロックを使い切った場合のみ黒（=次見出しの直前）。未使用のテンプレート
    //     手順行が下に残る場合、その境界はブロック途中なので透明に戻す。
    //     ※ top まで透明にすると共有辺の上書きで見出し行直下の黒線が消える（実測）
    formatRequests.push({
      updateBorders: {
        range: { sheetId: funcId, startRowIndex: r0, endRowIndex: r1, startColumnIndex: 1, endColumnIndex: 5 },
        innerHorizontal: SOLID_CLEAR,
        ...(fullyUsed ? {} : { bottom: SOLID_CLEAR }),
      },
    });
    // (4) C〜E の内側縦線（C|D・D|E）だけ灰破線に差し替え
    formatRequests.push({
      updateBorders: {
        range: { sheetId: funcId, startRowIndex: r0, endRowIndex: r1, startColumnIndex: 2, endColumnIndex: 5 },
        innerVertical: DASHED_GREY,
      },
    });
    // (5) 右端2枠: 横線＋枠左端のみ（内側縦線・右端線は引かない）
    for (const g0 of [FULL_GRID_END, FULL_GRID_END + 6]) {
      formatRequests.push({
        updateBorders: {
          range: { sheetId: funcId, startRowIndex: r0, endRowIndex: r1, startColumnIndex: g0, endColumnIndex: g0 + 6 },
          top: SOLID_BLACK, bottom: SOLID_BLACK, left: SOLID_BLACK, innerHorizontal: SOLID_BLACK,
        },
      });
    }
  });

  // 検証観点セル（D:E）の1行結合（サンプル実測: {c:[3,5]} の MERGE_ALL）
  // 塗装の後に行うこと: 結合はアンカー D の書式を保持し E を空にする。
  // 「E に罫線データなし」は人間作サンプルと同じ正常状態（表示は隣接セルの罫線で埋まる）
  // あわせて観点セルは折り返し（WRAP）にする（QC 指摘: 長い観点文言がセル幅で切れて見えない）
  for (const r of viewpointRows) {
    const range = { sheetId: funcId, startRowIndex: r, endRowIndex: r + 1, startColumnIndex: 3, endColumnIndex: 5 };
    formatRequests.push({ mergeCells: { range, mergeType: 'MERGE_ALL' } });
    formatRequests.push({
      repeatCell: {
        range,
        cell: { userEnteredFormat: { wrapStrategy: 'WRAP' } },
        fields: 'userEnteredFormat.wrapStrategy',
      },
    });
  }

  // 結果欄（H〜BJ列）の背景色: 期待する結果が空（準備・操作だけ）の手順行は
  // 灰色（原本実測: 71.76% グレー）、検証を伴う行（expected あり）は白に塗り分ける
  const GREY = { red: 0.7176471, green: 0.7176471, blue: 0.7176471 };
  const WHITE = { red: 1, green: 1, blue: 1 };
  const RESULT_COL_START = 7; // H 列
  const RESULT_COL_END = Math.min(62, colCount); // BJ 列まで
  for (const b of layout) {
    for (const s of b.steps) {
      formatRequests.push({
        repeatCell: {
          range: { sheetId: funcId, startRowIndex: s.row, endRowIndex: s.row + 1, startColumnIndex: RESULT_COL_START, endColumnIndex: RESULT_COL_END },
          cell: { userEnteredFormat: { backgroundColor: s.expected ? WHITE : GREY } },
          fields: 'userEnteredFormat.backgroundColor',
        },
      });
    }
  }

  // 本番確認タブ: 旧レイアウト・残存記入を全消しして機能テストタブの全範囲を複製する
  // （サンプル実測より、本番確認タブは機能テストタブと同一構成・同一ケースで運用されている）
  // 未使用の後続ブロックは行挿入の合計分だけ下にずれるため、その分を末尾に織り込む
  const totalInserted = inserts.reduce((sum, ins) => sum + ins.count, 0);
  const lastFuncRow = Math.max(
    ...layout.map((b) => b.steps.length ? b.steps[b.steps.length - 1].row : b.headerRow),
    ...analysis.blocks.map((b) => (b.stepRows[b.stepRows.length - 1] ?? b.headerRow) + totalInserted),
  ) + 1; // 末尾手順行の次まで含める
  const clearRows = Math.max(lastFuncRow + 50, 200); // 旧レイアウトの残骸を確実に覆う

  // C〜H 列のデータ行（ヘッダ行 R14 の1つ下〜末尾）は左揃え（QC 指摘: 長文手順が
  // テンプレ既定の中央揃えで読みづらい）。R14 の見出し行は中央揃えのまま触らない。
  // 本番確認タブへは直後の copyPaste で複製されるが、コピー範囲外の行も揃えるため
  // 両タブに明示適用する（本番確認側は copyPaste の後に適用）
  const leftAlignRequest = (sheetId) => ({
    repeatCell: {
      range: { sheetId, startRowIndex: analysis.headerRow + 1, endRowIndex: clearRows, startColumnIndex: 2, endColumnIndex: 8 },
      cell: { userEnteredFormat: { horizontalAlignment: 'LEFT' } },
      fields: 'userEnteredFormat.horizontalAlignment',
    },
  });
  // 「期待する結果」列（H）のデータ行は折り返し（WRAP）にする。原本テンプレは H 列の
  // wrapStrategy が行ごとに不統一（先頭行だけ WRAP、以降 OVERFLOW_CELL）で、明示しないと
  // 長い期待結果が右へはみ出して隣の結果記入欄に重なって見える。
  // G 列（手順）は原本が全行 WRAP なので触らない。
  const wrapExpectedRequest = (sheetId) => ({
    repeatCell: {
      range: { sheetId, startRowIndex: analysis.headerRow + 1, endRowIndex: clearRows, startColumnIndex: 7, endColumnIndex: 8 },
      cell: { userEnteredFormat: { wrapStrategy: 'WRAP' } },
      fields: 'userEnteredFormat.wrapStrategy',
    },
  });

  formatRequests.push(leftAlignRequest(funcId));
  formatRequests.push(wrapExpectedRequest(funcId));

  formatRequests.push(
    { unmergeCells: { range: { sheetId: prodId, startRowIndex: 0, endRowIndex: clearRows, startColumnIndex: 0, endColumnIndex: colCount } } },
    { updateCells: { range: { sheetId: prodId, startRowIndex: 0, endRowIndex: clearRows, startColumnIndex: 0, endColumnIndex: colCount }, fields: 'userEnteredValue,userEnteredFormat' } },
    {
      copyPaste: {
        source: { sheetId: funcId, startRowIndex: 0, endRowIndex: lastFuncRow + 1, startColumnIndex: 0, endColumnIndex: colCount },
        destination: { sheetId: prodId, startRowIndex: 0, endRowIndex: lastFuncRow + 1, startColumnIndex: 0, endColumnIndex: colCount },
        pasteType: 'PASTE_NORMAL',
        pasteOrientation: 'NORMAL',
      },
    },
    leftAlignRequest(prodId),
    wrapExpectedRequest(prodId),
  );

  // 不要タブの非表示化
  for (const title of plan.hideTabs || []) {
    const id = sheetIds[title];
    if (id == null) throw new Error(`hideTabs のシート「${title}」が見つかりません`);
    formatRequests.push({
      updateSheetProperties: { properties: { sheetId: id, hidden: true }, fields: 'hidden' },
    });
  }

  // --- values #2: 本番確認タブの URL / アカウント差し替え（コピー後に上書き）---
  const prodValueData = [];
  const pq = quoteSheet(SHEET_PROD);
  if (plan.prodSiteUrl) {
    prodValueData.push({ range: `${pq}!D${a1Row(analysis.siteUrlRow)}`, values: [[plan.prodSiteUrl]] });
  }
  (plan.prodAccounts || []).forEach((acc, i) => {
    const r = analysis.accountRows[i];
    if (r == null) throw new Error(`prodAccounts 数がテンプレートのアカウント行数を超えています`);
    prodValueData.push({ range: `${pq}!D${a1Row(r)}`, values: [[acc.idPass || '']] });
    prodValueData.push({ range: `${pq}!G${a1Row(r)}:H${a1Row(r)}`, values: [[acc.role || '', acc.required || '']] });
  });

  return { structuralRequests, valueData, formatRequests, prodValueData, layout, viewpointRows };
}

// ---- 既記入ガード ----

// テンプレートの手順行 G 列（テスト内容・手順）に既に値があれば「記入済み」と判定する。
// 原本コピー直後は空のはずなので、二重実行や誤対象を安全側で止める。
export function findExistingContent(analysis, rows) {
  const found = [];
  for (const block of analysis.blocks) {
    for (const r of block.stepRows) {
      const g = cell(rows, r, 6);
      if (g !== '') found.push({ row: a1Row(r), value: g.slice(0, 30) });
    }
  }
  return found;
}
