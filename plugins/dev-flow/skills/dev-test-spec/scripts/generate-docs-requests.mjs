// dev-test-spec: テスト計画 JSON の docs セクション → Google Docs batchUpdate リクエスト生成（純関数）
//
// Docs 版テスト仕様書（自動テストサマリー）の記入を Sheets 版と同じアーキテクチャで自動化する。
// 原本コピー後のドキュメント構造（タブ・見出しアンカー）を実行時に解析し、
// docs セクションの内容を「見出し直後への挿入」として生成する。
//
// 原本の構造（実測 2026-07-08、原本 1dM1l1TUYPFCuce1UAqm4xS7OtMyXk4NQdb2Yuaupygs）:
//   タブ1 実施概要: H2 要件定義書/ソース（開発）/機能テスト仕様書/本番確認テスト仕様書
//     × 各 H3 開発/作成者名・第三者チェック・URL・備考（機能テストのみ H4 E2EテストURL）
//   タブ2 機能テスト（サマリー）: H2 テストケース一覧 + H3 準備（プレースホルダー）
//   タブ3 機能テスト仕様書: H2 ログイン情報（サイトURL：等の行）/ H2 自動テスト
//     （H3 テスト環境の準備・テストシナリオ一覧・テスト結果）/ H2 手動テスト
//   タブ4 本番確認テスト仕様書: タブ3と同構造
//
// 挿入は同一タブ内でインデックス降順に並べる（前方挿入による index ずれ防止）。
// 挿入行はすべて明示的に namedStyleType / bullets を設定する
// （挿入テキストは直後の段落の書式を継承するため、無指定だと見出し化・bullet 化が起きる）。

// ---- タブ名（原本準拠） ----
export const TAB_OVERVIEW = '実施概要';
export const TAB_SUMMARY = '機能テスト（サマリー）';
export const TAB_FUNC = '機能テスト仕様書';
export const TAB_PROD = '本番確認テスト仕様書';

const BULLET_PRESET = 'BULLET_DISC_CIRCLE_SQUARE';

// ---- ドキュメント構造の解析 ----

// documents.get(includeTabsContent) の JSON からタブごとの段落一覧を平坦化する
export function analyzeDoc(doc) {
  const tabs = {};
  for (const tab of doc.tabs || []) {
    const title = tab.tabProperties.title;
    const tabId = tab.tabProperties.tabId;
    const paras = [];
    for (const el of tab.documentTab?.body?.content || []) {
      if (!el.paragraph) continue;
      const text = (el.paragraph.elements || [])
        .map((e) => e.textRun?.content || '').join('');
      paras.push({
        startIndex: el.startIndex,
        endIndex: el.endIndex,
        text: text.replace(/\n$/, ''),
        style: el.paragraph.paragraphStyle?.namedStyleType || 'NORMAL_TEXT',
        bullet: !!el.paragraph.bullet,
      });
    }
    tabs[title] = { tabId, paras };
  }
  return tabs;
}

// タブ内で「指定スタイルかつテキスト一致」の段落を探す（n 番目）
function findPara(tab, text, { style = null, nth = 0 } = {}) {
  let seen = 0;
  for (const p of tab.paras) {
    if (p.text.trim() !== text) continue;
    if (style && p.style !== style) continue;
    if (seen === nth) return p;
    seen += 1;
  }
  return null;
}

// アンカー段落の直後に既に本文があるか（空アンカー判定）。
// 次の非空段落が「本文」または「アンカーより下位レベルの見出し」なら記入済み。
// 同レベル以上の見出しが来る＝セクションが空、とみなす
export function headingLevel(style) {
  const m = /^HEADING_(\d)$/.exec(style || '');
  return m ? Number(m[1]) : 99; // 本文は最下位扱い
}
export function hasContentAfter(tab, para) {
  const next = tab.paras.find((p) => p.startIndex >= para.endIndex && p.text.trim() !== '');
  if (!next) return false;
  return headingLevel(next.style) > headingLevel(para.style);
}

// ---- 挿入ブロックの構築 ----

// line: { text, style: 'H3'|'H4'|'H5'|null, bullet: bool }
const h = (level, text) => ({ text, style: `HEADING_${level}`, bullet: false });
const b = (text) => ({ text, style: null, bullet: true });
const t = (text) => ({ text, style: null, bullet: false });

// docs セクションのスキーマ検証（サンプル粒度を構造で強制する）
export function validateDocsSection(docs) {
  if (!docs || typeof docs !== 'object') throw new Error('plan.docs がありません（Docs 記入には docs セクションが必須）');
  const req = (cond, msg) => { if (!cond) throw new Error(`plan.docs: ${msg}`); };
  req(docs.author, 'author（開発/作成者名）は必須です');
  req(Array.isArray(docs.requirementUrls) && docs.requirementUrls.length > 0, 'requirementUrls（Issue URL 等）は必須です');
  req(docs.sourceUrls && (docs.sourceUrls.frontend?.length || docs.sourceUrls.backend?.length), 'sourceUrls.frontend / backend のいずれかは必須です');
  req(Array.isArray(docs.e2eUrls) && docs.e2eUrls.length > 0, 'e2eUrls（E2E テストのパス/URL）は必須です');
  req(Array.isArray(docs.summaryGroups) && docs.summaryGroups.length > 0, 'summaryGroups（画面/機能別のテストケース一覧）は必須です');
  for (const g of docs.summaryGroups) {
    req(g.title && Array.isArray(g.items) && g.items.length > 0, `summaryGroups「${g.title ?? '?'}」に title と items が必要です`);
  }
  req(docs.resultSummary?.auto?.total != null, 'resultSummary.auto.total（自動テスト件数）は必須です');
  req(docs.resultSummary?.manual?.total != null, 'resultSummary.manual.total（手動テスト件数）は必須です');
  req(Array.isArray(docs.envPrerequisites) && docs.envPrerequisites.length > 0, 'envPrerequisites（前提条件）は必須です');
  req(Array.isArray(docs.envSetup) && docs.envSetup.length > 0, 'envSetup（セットアップ手順）は必須です');
  req(Array.isArray(docs.runCommands) && docs.runCommands.length > 0, 'runCommands（実行方法）は必須です');
  req(Array.isArray(docs.scenarioSections) && docs.scenarioSections.length > 0, 'scenarioSections（テストシナリオ一覧）は必須です');
  for (const sec of docs.scenarioSections) {
    req(sec.header && sec.file, `scenarioSections に header と file が必要です`);
    // サンプル実測の2形式: scenarios=詳細（ユーザーストーリー向け、目的＋流れ必須）
    //                      items=テスト名の列挙（機能テスト向け、グループ見出し＋テスト名）
    const hasScenarios = Array.isArray(sec.scenarios) && sec.scenarios.length > 0;
    const hasItems = Array.isArray(sec.items) && sec.items.length > 0;
    req(hasScenarios || hasItems, `scenarioSections「${sec.header}」に scenarios（詳細）か items（テスト名列挙）が必要です`);
    for (const sc of sec.scenarios || []) {
      req(sc.name && sc.purpose && Array.isArray(sc.flow) && sc.flow.length > 0,
        `シナリオ「${sc.name ?? '?'}」には name・purpose・flow（自動テストの流れ）が必須です（サンプル粒度）`);
    }
  }
  req(Array.isArray(docs.testResult) && docs.testResult.length > 0, 'testResult（テスト結果）は必須です');
  req(docs.manual?.specUrl && Array.isArray(docs.manual.summary) && docs.manual.summary.length > 0,
    'manual.specUrl と manual.summary（手動テスト仕様書への参照）は必須です');
  return docs;
}

// シナリオ一覧ブロック（サンプル粒度: 区切り線＋シナリオごとに目的・自動テストの流れ）
function scenarioBlocks(sections) {
  const lines = [];
  const rule = '─'.repeat(30);
  sections.forEach((sec) => {
    lines.push(t(rule));
    lines.push(t(sec.header));
    lines.push(t(rule));
    lines.push(t(`ファイル: ${sec.file}`));
    (sec.scenarios || []).forEach((sc, i) => {
      lines.push(t(''));
      lines.push(t(`シナリオ${i + 1}: ${sc.name}`));
      lines.push(t(`目的: ${sc.purpose}`));
      lines.push(t('【自動テストの流れ】'));
      sc.flow.forEach((step, j) => lines.push(t(`${j + 1}. ${step}`)));
    });
    // テスト名列挙: グループ見出し（● 始まり）の前に空行を自動挿入する
    // （サンプル実測: グループ間は1行空く。plan JSON 側で空行を書く必要はない）
    (sec.items || []).forEach((item) => {
      if (item.startsWith('●') && lines.length > 0 && lines[lines.length - 1].text !== '') {
        lines.push(t(''));
      }
      lines.push(t(item));
    });
    lines.push(t(''));
  });
  return lines;
}

// 環境準備ブロック（サンプル粒度: H4 1.1/1.2/1.3、実行方法は H5 でコマンド別）
function envBlocks(docs) {
  const lines = [];
  lines.push(h(4, '1.1 前提条件'));
  docs.envPrerequisites.forEach((x) => lines.push(t(x)));
  lines.push(h(4, '1.2 テスト環境のセットアップ'));
  docs.envSetup.forEach((x) => lines.push(t(x)));
  lines.push(h(4, '1.3 テストの実行方法'));
  docs.runCommands.forEach((rc) => {
    lines.push(h(5, rc.label));
    lines.push(t(rc.command));
  });
  return lines;
}

// 結果サマリーブロック
function resultSummaryLines(rs) {
  const lines = [];
  lines.push(b(`自動テスト（E2E）: ${rs.auto.total}件`));
  (rs.auto.breakdown || []).forEach((x) => lines.push(b(`- ${x.label}: ${x.count}件`)));
  lines.push(b(`手動テスト: ${rs.manual.total}件`));
  (rs.manual.breakdown || []).forEach((x) => lines.push(b(`- ${x.label}: ${x.count}件`)));
  lines.push(b(`合計: ${(rs.auto.total || 0) + (rs.manual.total || 0)}件`));
  if (rs.note) lines.push(b(rs.note));
  return lines;
}

// ---- 挿入ターゲットの列挙 ----

// 戻り値: [{ tabTitle, anchorDesc, para(アンカー段落), lines, mode: 'after'|'append-inline'|'replace-next' }]
export function planInsertions(tabs, plan) {
  const docs = validateDocsSection(plan.docs);
  const targets = [];
  const missing = [];

  // アンカー直後に連なる空段落（原本の空 bullet プレースホルダー）。
  // 残すと裸の「●」がレイアウト崩れとして見えるため、挿入時に削除する
  const emptyRunAfter = (tab, para) => {
    const run = [];
    for (const p of tab.paras) {
      if (p.startIndex < para.endIndex) continue;
      if (p.text.trim() !== '') break;
      if (run.length > 0 && p.startIndex !== run[run.length - 1].endIndex) break;
      if (run.length === 0 && p.startIndex !== para.endIndex) break;
      run.push(p);
    }
    if (run.length === 0) return null;
    const segmentEnd = tab.paras[tab.paras.length - 1].endIndex;
    // セグメント最後の改行は削除できないため clamp（末尾に空行1つ残るのは許容）
    const end = Math.min(run[run.length - 1].endIndex, segmentEnd - 1);
    return end > run[0].startIndex ? { start: run[0].startIndex, end } : null;
  };

  const anchorAfter = (tabTitle, text, opts, lines, desc) => {
    const tab = tabs[tabTitle];
    if (!tab) { missing.push(`タブ「${tabTitle}」が見つかりません`); return; }
    const para = findPara(tab, text, opts);
    if (!para) { missing.push(`${tabTitle}: アンカー「${text}」(${opts.nth ?? 0}番目) が見つかりません`); return; }
    targets.push({
      tabTitle, tabId: tab.tabId, anchorDesc: desc, para, lines, mode: 'after',
      filled: hasContentAfter(tab, para), emptyRun: emptyRunAfter(tab, para),
    });
  };

  // --- タブ1 実施概要 ---
  // H2 セクション順: 要件定義書(0) / ソース（開発）(1) / 機能テスト仕様書(2) / 本番確認テスト仕様書(3)
  for (let i = 0; i < 4; i++) {
    anchorAfter(TAB_OVERVIEW, '開発/作成者名', { style: 'HEADING_3', nth: i }, [b(docs.author)], `実施概要: 開発/作成者名 (${i + 1}つ目)`);
  }
  anchorAfter(TAB_OVERVIEW, 'URL・備考', { style: 'HEADING_3', nth: 0 },
    docs.requirementUrls.map(b), '実施概要: 要件定義書 URL');
  anchorAfter(TAB_OVERVIEW, 'URL・備考', { style: 'HEADING_3', nth: 1 },
    [
      ...(docs.sourceUrls.frontend?.length ? [b('▼フロントエンド'), ...docs.sourceUrls.frontend.map(b)] : []),
      ...(docs.sourceUrls.backend?.length ? [b('▼バックエンド'), ...docs.sourceUrls.backend.map(b)] : []),
    ], '実施概要: ソース URL');
  anchorAfter(TAB_OVERVIEW, 'E2EテストURL', { style: 'HEADING_4', nth: 0 },
    docs.e2eUrls.map(b), '実施概要: E2EテストURL');
  anchorAfter(TAB_OVERVIEW, 'URL・備考', { style: 'HEADING_3', nth: 3 },
    [b('本タブ「本番確認テスト仕様書」を参照')], '実施概要: 本番確認 URL・備考');

  // --- タブ2 機能テスト（サマリー） ---
  // 原本の「H3 準備」プレースホルダーを summaryGroups（H3+箇条書き）で置き換え、
  // 末尾に H2 テスト結果サマリーを追加する
  {
    const tab = tabs[TAB_SUMMARY];
    if (!tab) { missing.push(`タブ「${TAB_SUMMARY}」が見つかりません`); }
    else {
      const prep = findPara(tab, '準備', { style: 'HEADING_3' });
      const caseLines = docs.summaryGroups.flatMap((g) => [h(3, g.title), ...g.items.map(b)]);
      // 「準備」プレースホルダーは記入済みドキュメントでは消えているのが正常なので、
      // 見つからなくても missing にしない（残存チェックは verify 側で行う）
      if (prep) {
        targets.push({
          tabTitle: TAB_SUMMARY, tabId: tab.tabId, anchorDesc: 'サマリー: テストケース一覧（H3 準備 を置換）',
          para: prep, lines: caseLines, mode: 'replace-next', filled: false,
        });
      }
      // テスト結果サマリーはタブ末尾に追加（既にあればスキップ）。
      // セグメント末尾には挿入できない（index < segmentEnd 制約）ため
      // 最終改行の手前に入れる専用モード append-end を使う
      const already = findPara(tab, 'テスト結果サマリー', { style: 'HEADING_2' });
      const last = tab.paras[tab.paras.length - 1];
      targets.push({
        tabTitle: TAB_SUMMARY, tabId: tab.tabId, anchorDesc: 'サマリー: テスト結果サマリー（末尾追加）',
        para: last, lines: [h(2, 'テスト結果サマリー'), ...resultSummaryLines(docs.resultSummary)],
        mode: 'append-end', filled: !!already,
      });
    }
  }

  // --- タブ3 機能テスト仕様書 / タブ4 本番確認テスト仕様書 ---
  const prod = docs.prod || {};
  const pending = (v, ph) => v || `（${ph}・デプロイ後確定）`;
  const accountLines = (tabTitle, siteUrl, idPass, role) => {
    const [id, pass] = (idPass || ' / ').split('/').map((s) => s.trim());
    return [
      ['サイトURL：', siteUrl],
      ['ログインID：', id],
      ['パスワード：', pass],
      ['権限：', role],
    ].map(([label, value]) => ({ tabTitle, label, value: value || '' }));
  };

  const funcAccount = plan.accounts?.[0] || {};
  const inlineTargets = [
    ...accountLines(TAB_FUNC, plan.siteUrl, funcAccount.idPass, funcAccount.role),
    ...accountLines(TAB_PROD,
      pending(prod.siteUrl ?? plan.prodSiteUrl, '本番URLに置き換え'),
      prod.account?.idPass ?? plan.prodAccounts?.[0]?.idPass ?? '（本番アカウントに置き換え・デプロイ後確定） / （同左）',
      prod.account?.role ?? plan.prodAccounts?.[0]?.role ?? funcAccount.role),
  ];
  for (const it of inlineTargets) {
    const tab = tabs[it.tabTitle];
    if (!tab) continue;
    const para = findPara(tab, it.label) || tab.paras.find((p) => p.text.trim().startsWith(it.label));
    if (!para) { missing.push(`${it.tabTitle}: 行「${it.label}」が見つかりません`); continue; }
    targets.push({
      tabTitle: it.tabTitle, tabId: tab.tabId, anchorDesc: `${it.tabTitle}: ${it.label}`,
      para, lines: [t(it.value)], mode: 'append-inline',
      filled: para.text.trim().length > it.label.length,
    });
  }

  const funcSections = [
    ['テスト環境の準備', envBlocks(docs), '環境準備'],
    ['テストシナリオ一覧', scenarioBlocks(docs.scenarioSections), 'シナリオ一覧'],
    ['テスト結果', docs.testResult.map(b), 'テスト結果'],
  ];
  for (const [anchor, lines, desc] of funcSections) {
    anchorAfter(TAB_FUNC, anchor, { style: 'HEADING_3', nth: 0 }, lines, `機能テスト仕様書: ${desc}`);
  }
  anchorAfter(TAB_FUNC, '手動テスト', { style: 'HEADING_2', nth: 0 },
    [b(`手動テスト仕様書（スプレッドシート版）: ${docs.manual.specUrl}`), ...docs.manual.summary.map(b)],
    '機能テスト仕様書: 手動テスト');

  const prodSections = [
    ['テスト環境の準備', (prod.envPrep || ['本番 URL に対して機能テスト仕様書タブと同一の E2E を実行する']).map(b), '環境準備'],
    ['テストシナリオ一覧', [t(prod.scenarioNote || '機能テスト仕様書タブと同一シナリオを本番 URL に対して実行する')], 'シナリオ一覧'],
    ['テスト結果', (prod.testResult || ['本番デプロイ後に実施し記入']).map(b), 'テスト結果'],
  ];
  for (const [anchor, lines, desc] of prodSections) {
    anchorAfter(TAB_PROD, anchor, { style: 'HEADING_3', nth: 0 }, lines, `本番確認: ${desc}`);
  }
  anchorAfter(TAB_PROD, '手動テスト', { style: 'HEADING_2', nth: 0 },
    (prod.manualNote || [`本番デプロイ後、手動テスト仕様書（スプレッドシート版）を本番 URL で再実施: ${docs.manual.specUrl}`]).map(b),
    '本番確認: 手動テスト');

  return { targets, missing };
}

// ---- batchUpdate リクエスト生成 ----

// 挿入ターゲット群 → リクエスト列。同一タブ内はアンカー位置の降順（前方の index を壊さない）
export function buildDocsRequests(doc, plan, { force = false } = {}) {
  const tabs = analyzeDoc(doc);
  const { targets, missing } = planInsertions(tabs, plan);
  if (missing.length > 0) {
    throw new Error(`ドキュメント構造が原本と一致しません:\n  - ${missing.join('\n  - ')}`);
  }

  // 実際の挿入位置（モード別）。ソートもこの値の降順で行う
  // （段落開始位置でソートすると、同一段落への「置換」と「直後挿入」が
  //   昇順に並び、後続挿入の index が前の挿入でずれる）
  const insertAtOf = (tg) =>
    tg.mode === 'replace-next' ? tg.para.startIndex
      : (tg.mode === 'append-inline' || tg.mode === 'append-end') ? tg.para.endIndex - 1
        : tg.para.endIndex;

  const skipped = targets.filter((tg) => tg.filled && !force);
  const todo = targets.filter((tg) => !tg.filled || force)
    .sort((a, b2) => (a.tabId === b2.tabId ? insertAtOf(b2) - insertAtOf(a) : a.tabId.localeCompare(b2.tabId)));

  const requests = [];
  for (const tg of todo) {
    const loc = (index) => ({ index, tabId: tg.tabId });
    if (tg.mode === 'append-inline') {
      // 「サイトURL：」行の末尾（改行の手前）に値を追記
      requests.push({ insertText: { location: loc(insertAtOf(tg)), text: tg.lines[0].text } });
      continue;
    }
    const insertAt = insertAtOf(tg);
    const text = tg.lines.map((l) => l.text + '\n').join('');
    requests.push({ insertText: { location: loc(insertAt), text } });

    // 挿入した各行に段落スタイルと bullet を明示適用（直後の段落の書式継承を上書きする）。
    // 非 bullet 行には deleteParagraphBullets を明示発行する — 挿入先が bullet 段落
    // だった場合、見出しを含む挿入行が bullet を継承してしまうため（実障害:
    // 末尾追加した H2 見出しが「● テスト結果サマリー」になった）
    let cursor = insertAt;
    let bulletRun = null;
    let plainRun = null;
    const flushBullets = () => {
      if (bulletRun) {
        requests.push({ createParagraphBullets: { range: { startIndex: bulletRun[0], endIndex: bulletRun[1], tabId: tg.tabId }, bulletPreset: BULLET_PRESET } });
        bulletRun = null;
      }
    };
    const flushPlain = () => {
      if (plainRun) {
        requests.push({ deleteParagraphBullets: { range: { startIndex: plainRun[0], endIndex: plainRun[1], tabId: tg.tabId } } });
        plainRun = null;
      }
    };
    for (const line of tg.lines) {
      const start = cursor;
      const end = cursor + line.text.length + 1;
      requests.push({
        updateParagraphStyle: {
          range: { startIndex: start, endIndex: end, tabId: tg.tabId },
          paragraphStyle: { namedStyleType: line.style || 'NORMAL_TEXT' },
          fields: 'namedStyleType',
        },
      });
      if (line.bullet) {
        flushPlain();
        bulletRun = bulletRun ? [bulletRun[0], end] : [start, end];
      } else {
        flushBullets();
        plainRun = plainRun ? [plainRun[0], end] : [start, end];
      }
      cursor = end;
    }
    flushBullets();
    flushPlain();

    // append-end: 挿入位置の後ろに残る旧・最終段落（改行のみ）が bullet を
    // 持っていると裸の「●」が末尾に残るため、bullet を外して通常段落に戻す
    if (tg.mode === 'append-end') {
      const tail = { startIndex: insertAt + text.length, endIndex: insertAt + text.length + 1, tabId: tg.tabId };
      requests.push({ deleteParagraphBullets: { range: tail } });
      requests.push({
        updateParagraphStyle: { range: tail, paragraphStyle: { namedStyleType: 'NORMAL_TEXT' }, fields: 'namedStyleType' },
      });
    }

    if (tg.mode === 'replace-next') {
      const shift = text.length;
      requests.push({
        deleteContentRange: {
          range: { startIndex: tg.para.startIndex + shift, endIndex: tg.para.endIndex + shift, tabId: tg.tabId },
        },
      });
    }
    // アンカー直後にあった空段落（空 bullet プレースホルダー）を、挿入分ずらして削除
    if (tg.mode === 'after' && tg.emptyRun) {
      const shift = text.length;
      requests.push({
        deleteContentRange: {
          range: { startIndex: tg.emptyRun.start + shift, endIndex: tg.emptyRun.end + shift, tabId: tg.tabId },
        },
      });
    }
  }

  return { requests, todo, skipped };
}
