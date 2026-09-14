import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TAB_OVERVIEW, TAB_SUMMARY, TAB_FUNC, TAB_PROD,
  analyzeDoc, validateDocsSection, planInsertions, buildDocsRequests,
} from './generate-docs-requests.mjs';

// ---- fixture: 原本 Docs の実測構造（2026-07-08）を模す ----

function mkTab(tabId, title, lines) {
  let index = 1;
  const content = lines.map(([style, text]) => {
    const startIndex = index;
    const endIndex = index + text.length + 1;
    index = endIndex;
    return {
      startIndex, endIndex,
      paragraph: {
        paragraphStyle: { namedStyleType: style },
        elements: [{ textRun: { content: `${text}\n` } }],
      },
    };
  });
  return { tabProperties: { tabId, title }, documentTab: { body: { content } } };
}

const H1 = 'HEADING_1'; const H2 = 'HEADING_2'; const H3 = 'HEADING_3'; const H4 = 'HEADING_4'; const N = 'NORMAL_TEXT';

function overviewSection(withE2e = false) {
  return [
    [H3, '開発/作成者名'],
    [H3, '第三者チェック'],
    [N, '実施者名：まるっとのため不要'],
    [N, '実施日：-'],
    [H3, 'URL・備考'],
    ...(withE2e ? [[H4, 'E2EテストURL']] : []),
  ];
}

function specTabLines() {
  return [
    [H1, '機能テスト仕様書'],
    [H2, 'ログイン情報'],
    [H3, 'アカウント1'],
    [N, 'サイトURL：'],
    [N, 'ログインID：'],
    [N, 'パスワード：'],
    [N, '権限：'],
    [H3, 'アカウント2'],
    [N, 'なし'],
    [H2, '自動テスト'],
    [H3, 'テスト環境の準備'],
    [H3, 'テストシナリオ一覧'],
    [H3, 'テスト結果'],
    [H2, '手動テスト'],
    [H2, 'QC指摘事項の修正対応'],
  ];
}

function mkDoc() {
  return {
    title: '【試験】総合テスト仕様書',
    tabs: [
      mkTab('t.ov', TAB_OVERVIEW, [
        [H1, '実施概要'],
        [H2, '要件定義書'], ...overviewSection(),
        [H2, 'ソース（開発）'], ...overviewSection(),
        [H2, '機能テスト仕様書'], ...overviewSection(true),
        [H2, '本番確認テスト仕様書'], ...overviewSection(),
      ]),
      mkTab('t.sum', TAB_SUMMARY, [
        [H1, '機能テスト（サマリー）'],
        [H2, 'テストケース一覧 '],
        [H3, '準備'],
      ]),
      mkTab('t.func', TAB_FUNC, specTabLines()),
      mkTab('t.prod', TAB_PROD, specTabLines()),
    ],
  };
}

function mkDocsSection(overrides = {}) {
  return {
    author: '北村',
    requirementUrls: ['https://github.com/org/repo/issues/227'],
    sourceUrls: { frontend: ['https://github.com/org/fe/pull/72'], backend: ['https://github.com/org/be/pull/229'] },
    e2eUrls: ['e2e/tests/functional/nickname-functional.spec.ts'],
    summaryGroups: [
      { title: '利用者追加画面の確認', items: ['ニックネーム欄が表示されること', '50文字まで入力できること'] },
      { title: 'CSV一括登録の確認', items: ['テンプレートにニックネーム列があること'] },
    ],
    resultSummary: {
      auto: { total: 24, breakdown: [{ label: '機能テスト', count: 24 }] },
      manual: { total: 13, breakdown: [{ label: '帳票実ファイル確認', count: 5 }] },
    },
    envPrerequisites: ['Node.js がインストール済みであること'],
    envSetup: ['$ cd example-frontend', '$ npm ci'],
    runCommands: [{ label: '全テスト実行', command: '$ npx playwright test --config=e2e/playwright.config.ts' }],
    scenarioSections: [
      {
        header: '機能テスト（24テスト）', file: 'e2e/tests/functional/nickname-functional.spec.ts',
        scenarios: [
          { name: '追加画面でニックネームを登録できる', purpose: '登録フローの確認', flow: ['追加画面に遷移', 'ニックネームを入力', '検証: 一覧に表示される'] },
        ],
      },
    ],
    testResult: ['24 件 全 PASS（2026-07-08 実行）'],
    manual: { specUrl: 'https://docs.google.com/spreadsheets/d/XXX/edit', summary: ['全13ケース'] },
    ...overrides,
  };
}

function mkPlan(docsOverrides = {}, planOverrides = {}) {
  return {
    siteUrl: 'https://stg.example.com/',
    prodSiteUrl: 'https://app.example.com/',
    accounts: [{ idPass: 'test@example.com / password', role: 'テナント管理者', required: '要' }],
    prodAccounts: [{ idPass: 'test@example.com / password', role: 'テナント管理者', required: '要' }],
    groups: [],
    docs: mkDocsSection(docsOverrides),
    ...planOverrides,
  };
}

// ---- analyzeDoc ----

test('analyzeDoc: タブ別に段落（テキスト・スタイル・index）を平坦化する', () => {
  const tabs = analyzeDoc(mkDoc());
  assert.deepEqual(Object.keys(tabs), [TAB_OVERVIEW, TAB_SUMMARY, TAB_FUNC, TAB_PROD]);
  const ov = tabs[TAB_OVERVIEW];
  assert.equal(ov.tabId, 't.ov');
  assert.equal(ov.paras[0].text, '実施概要');
  assert.equal(ov.paras[0].style, 'HEADING_1');
  assert.equal(ov.paras[0].startIndex, 1);
});

// ---- validateDocsSection ----

test('validateDocsSection: 必須項目の欠落を弾く（サンプル粒度の強制）', () => {
  assert.throws(() => validateDocsSection(null), /docs セクションが必須/);
  assert.throws(() => validateDocsSection(mkDocsSection({ author: undefined })), /author/);
  assert.throws(() => validateDocsSection(mkDocsSection({ summaryGroups: [] })), /summaryGroups/);
  // シナリオに purpose / flow がないと弾く（件数の羅列だけの低粒度を防ぐ）
  assert.throws(() => validateDocsSection(mkDocsSection({
    scenarioSections: [{ header: 'x', file: 'y', scenarios: [{ name: 'a' }] }],
  })), /purpose・flow/);
  // scenarios も items もないセクションは弾く
  assert.throws(() => validateDocsSection(mkDocsSection({
    scenarioSections: [{ header: 'x', file: 'y' }],
  })), /scenarios（詳細）か items/);
  // items（テスト名列挙）形式は許容（サンプルの機能テスト部分と同形式）
  validateDocsSection(mkDocsSection({
    scenarioSections: [{ header: '機能テスト（24テスト）', file: 'y', items: ['●追加画面の確認（3テスト）', '1. 表示されること'] }],
  }));
});

// ---- planInsertions ----

test('planInsertions: 原本構造の全アンカーを解決する（missing なし）', () => {
  const tabs = analyzeDoc(mkDoc());
  const { targets, missing } = planInsertions(tabs, mkPlan());
  assert.deepEqual(missing, []);
  const descs = targets.map((tg) => tg.anchorDesc);
  // 実施概要: 開発/作成者名 ×4 + URL 系 3 箇所
  assert.equal(descs.filter((d) => d.includes('開発/作成者名')).length, 4);
  assert.ok(descs.includes('実施概要: E2EテストURL'));
  // サマリー: 置換 + 末尾追加
  assert.ok(descs.some((d) => d.includes('H3 準備 を置換')));
  assert.ok(descs.some((d) => d.includes('テスト結果サマリー')));
  // 機能テスト・本番確認: 各セクション
  for (const tab of ['機能テスト仕様書', '本番確認']) {
    for (const sec of ['環境準備', 'シナリオ一覧', 'テスト結果']) {
      assert.ok(descs.some((d) => d.startsWith(tab) && d.includes(sec)), `${tab}/${sec}`);
    }
  }
  // ログイン情報のインライン追記 ×8（両タブ×4行）
  assert.equal(targets.filter((tg) => tg.mode === 'append-inline').length, 8);
});

test('planInsertions: prodSiteUrl 等が無ければ「デプロイ後確定」プレースホルダー', () => {
  const tabs = analyzeDoc(mkDoc());
  const plan = mkPlan({}, { prodSiteUrl: undefined, prodAccounts: [] });
  const { targets } = planInsertions(tabs, plan);
  const prodSite = targets.find((tg) => tg.mode === 'append-inline' && tg.tabTitle === TAB_PROD && tg.anchorDesc.includes('サイトURL'));
  assert.match(prodSite.lines[0].text, /デプロイ後確定/);
});

// ---- buildDocsRequests ----

test('buildDocsRequests: 同一タブ内の挿入はアンカー位置の降順', () => {
  const { requests } = buildDocsRequests(mkDoc(), mkPlan());
  const insertsByTab = {};
  for (const r of requests) {
    if (!r.insertText?.location) continue;
    const { tabId, index } = r.insertText.location;
    (insertsByTab[tabId] ??= []).push(index);
  }
  for (const [tabId, indices] of Object.entries(insertsByTab)) {
    for (let i = 1; i < indices.length; i++) {
      assert.ok(indices[i] <= indices[i - 1], `${tabId} の挿入が降順でない: ${indices}`);
    }
  }
});

test('buildDocsRequests: 挿入行には段落スタイルを明示し、bullet 行には bullets を適用する', () => {
  const { requests } = buildDocsRequests(mkDoc(), mkPlan());
  // 実施概要の author bullet: NORMAL_TEXT の明示＋createParagraphBullets が存在
  assert.ok(requests.some((r) => r.updateParagraphStyle?.paragraphStyle.namedStyleType === 'NORMAL_TEXT'));
  assert.ok(requests.some((r) => r.createParagraphBullets?.bulletPreset === 'BULLET_DISC_CIRCLE_SQUARE'));
  // 環境準備の H4/H5 見出し
  assert.ok(requests.some((r) => r.updateParagraphStyle?.paragraphStyle.namedStyleType === 'HEADING_4'));
  assert.ok(requests.some((r) => r.updateParagraphStyle?.paragraphStyle.namedStyleType === 'HEADING_5'));
});

test('buildDocsRequests: ログイン情報は行末（改行の手前）へのインライン追記', () => {
  const doc = mkDoc();
  const { requests } = buildDocsRequests(doc, mkPlan());
  const tabs = analyzeDoc(doc);
  const sitePara = tabs[TAB_FUNC].paras.find((p) => p.text === 'サイトURL：');
  const inline = requests.find((r) => r.insertText?.text === 'https://stg.example.com/' && r.insertText.location.tabId === 't.func');
  assert.ok(inline, 'サイトURL の追記があるべき');
  assert.equal(inline.insertText.location.index, sitePara.endIndex - 1);
});

test('buildDocsRequests: タブ末尾への追加はセグメント末尾の1つ手前に挿入する', () => {
  const doc = mkDoc();
  const { requests } = buildDocsRequests(doc, mkPlan());
  const tabs = analyzeDoc(doc);
  const last = tabs[TAB_SUMMARY].paras.at(-1);
  const tail = requests.find((r) => r.insertText?.location.tabId === 't.sum' && r.insertText.text.startsWith('テスト結果サマリー'));
  assert.ok(tail, '末尾追加の挿入があるべき');
  assert.equal(tail.insertText.location.index, last.endIndex - 1, 'index < segmentEnd 制約（Docs API）');
});

test('buildDocsRequests: 非 bullet 行には deleteParagraphBullets を発行する（bullet 継承の解除）', () => {
  const { requests } = buildDocsRequests(mkDoc(), mkPlan());
  const dels = requests.filter((r) => r.deleteParagraphBullets);
  assert.ok(dels.length > 0, '非 bullet 行の bullet 解除があるべき');
  // 環境準備（H4/H5/本文の連続 = 非 bullet）の挿入に対して解除レンジがあること
  const envInsert = requests.find((r) => r.insertText?.text.includes('1.1 前提条件'));
  assert.ok(dels.some((d) => d.deleteParagraphBullets.range.tabId === envInsert.insertText.location.tabId
    && d.deleteParagraphBullets.range.startIndex >= envInsert.insertText.location.index));
});

test('buildDocsRequests: append-end の後ろに残る旧最終段落の bullet を外し通常段落に戻す', () => {
  const { requests } = buildDocsRequests(mkDoc(), mkPlan());
  const tail = requests.find((r) => r.insertText?.text.startsWith('テスト結果サマリー'));
  const tailEnd = tail.insertText.location.index + tail.insertText.text.length;
  const del = requests.find((r) => r.deleteParagraphBullets
    && r.deleteParagraphBullets.range.tabId === 't.sum'
    && r.deleteParagraphBullets.range.startIndex === tailEnd);
  assert.ok(del, '旧最終段落（改行のみ）の bullet 解除があるべき');
  assert.equal(del.deleteParagraphBullets.range.endIndex, tailEnd + 1);
});

test('buildDocsRequests: items のグループ見出し（●）の前に空行が自動で入る', () => {
  const { requests } = buildDocsRequests(mkDoc(), mkPlan({
    scenarioSections: [{
      header: '機能テスト（3テスト）', file: 'y',
      items: ['●グループA（2テスト）', '1. テスト1', '2. テスト2', '●グループB（1テスト）', '3. テスト3'],
    }],
  }));
  const ins = requests.find((r) => r.insertText?.text.includes('●グループB'));
  assert.match(ins.insertText.text, /テスト2\n\n●グループB/, 'グループ間に空行が入るべき');
});

test('buildDocsRequests: サマリーの「準備」置換は挿入→ずらした位置の削除', () => {
  const doc = mkDoc();
  const { requests } = buildDocsRequests(doc, mkPlan());
  const tabs = analyzeDoc(doc);
  const prep = tabs[TAB_SUMMARY].paras.find((p) => p.text === '準備');
  const del = requests.find((r) => r.deleteContentRange?.range.tabId === 't.sum');
  assert.ok(del, '準備の削除があるべき');
  const ins = requests.find((r) => r.insertText?.location.tabId === 't.sum' && r.insertText.location.index === prep.startIndex);
  assert.ok(ins, '準備の位置への挿入があるべき');
  assert.equal(del.deleteContentRange.range.startIndex, prep.startIndex + ins.insertText.text.length);
  assert.equal(del.deleteContentRange.range.endIndex, prep.endIndex + ins.insertText.text.length);
});

test('buildDocsRequests: アンカー直後の空 bullet プレースホルダーを挿入分ずらして削除する', () => {
  const doc = mkDoc();
  // 最初の「開発/作成者名」直後に空段落（原本の空 bullet）を差し込む
  const ov = doc.tabs[0].documentTab.body.content;
  const idx = ov.findIndex((el) => el.paragraph.elements[0].textRun.content.startsWith('開発/作成者名'));
  const anchorEnd = ov[idx].endIndex;
  ov.splice(idx + 1, 0, {
    startIndex: anchorEnd, endIndex: anchorEnd + 1,
    paragraph: { paragraphStyle: { namedStyleType: 'NORMAL_TEXT' }, elements: [{ textRun: { content: '\n' } }] },
  });
  // 後続段落の index を 1 ずらす
  for (let i = idx + 2; i < ov.length; i++) { ov[i].startIndex += 1; ov[i].endIndex += 1; }
  const { requests } = buildDocsRequests(doc, mkPlan());
  const ins = requests.find((r) => r.insertText?.location.index === anchorEnd && r.insertText.location.tabId === 't.ov');
  assert.ok(ins, '空段落があっても挿入位置はアンカー直後');
  const del = requests.find((r) => r.deleteContentRange
    && r.deleteContentRange.range.tabId === 't.ov'
    && r.deleteContentRange.range.startIndex === anchorEnd + ins.insertText.text.length);
  assert.ok(del, '空段落の削除（挿入分シフト済み）があるべき');
  assert.equal(del.deleteContentRange.range.endIndex, anchorEnd + 1 + ins.insertText.text.length);
});

test('buildDocsRequests: 記入済みアンカーはスキップし、--force で対象に戻る', () => {
  const doc = mkDoc();
  // 実施概要の最初の「開発/作成者名」直後に本文を差し込んだ状態を作る
  const ov = doc.tabs[0].documentTab.body.content;
  const idx = ov.findIndex((el) => el.paragraph.elements[0].textRun.content.startsWith('開発/作成者名'));
  ov.splice(idx + 1, 0, {
    startIndex: ov[idx].endIndex, endIndex: ov[idx].endIndex + 3,
    paragraph: { paragraphStyle: { namedStyleType: 'NORMAL_TEXT' }, elements: [{ textRun: { content: '北村\n' } }] },
  });
  const { skipped } = buildDocsRequests(doc, mkPlan());
  assert.ok(skipped.some((s) => s.anchorDesc.includes('開発/作成者名')));
  const forced = buildDocsRequests(doc, mkPlan(), { force: true });
  assert.equal(forced.skipped.length, 0);
});

test('buildDocsRequests: 原本と構造が違う（アンカー欠落）なら throw', () => {
  const doc = mkDoc();
  doc.tabs[2].documentTab.body.content = doc.tabs[2].documentTab.body.content.filter(
    (el) => !el.paragraph.elements[0].textRun.content.startsWith('テストシナリオ一覧'),
  );
  assert.throws(() => buildDocsRequests(doc, mkPlan()), /構造が原本と一致しません/);
});
