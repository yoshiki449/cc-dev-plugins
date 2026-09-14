import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintPlan } from './lint-plan.mjs';

function mkPlan(overrides = {}) {
  return {
    siteUrl: 'https://stg.example.com/',
    prodSiteUrl: 'https://app.example.com/',
    accounts: [{ idPass: 'test@example.com / password', role: 'テナント管理者', required: '要' }],
    groups: [
      {
        no: '00', title: '準備',
        cases: [{ steps: [{ content: '管理者でログインし、受入企業を1社作成する（以下、「受入企業A」とする）' }] }],
      },
      {
        no: '01', title: '帳票出力の確認',
        cases: [{
          viewpoint: '出力結果の検証',
          steps: [
            { content: '「受入企業A」を選択して面談結果を追加する' },
            { content: 'No.01 で追加した面談結果を帳票出力する', expected: '内容が反映されている' },
          ],
        }],
      },
      {
        no: '02', title: '後片付け',
        cases: [{ steps: [{ content: '受入企業Aを削除する', expected: '正常に削除される' }] }],
      },
    ],
    ...overrides,
  };
}

const codes = (findings) => findings.map((f) => f.code);
const byCode = (findings, code) => findings.filter((f) => f.code === code);

test('lintPlan: 問題のない plan は指摘なし', () => {
  assert.deepEqual(lintPlan(mkPlan()), []);
});

test('lintPlan: 壊れた構造は schema エラー1件で打ち切り', () => {
  const findings = lintPlan({ groups: [] });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, 'schema');
  assert.equal(findings[0].level, 'error');
});

test('lintPlan: グループ内に存在しない手順番号の参照は error', () => {
  const plan = mkPlan();
  plan.groups[1].cases[0].steps[1].content = 'No.05 で追加した面談結果を出力する';
  const found = byCode(lintPlan(plan), 'ref-step');
  assert.equal(found.length, 1);
  assert.equal(found[0].level, 'error');
  assert.match(found[0].message, /No\.05/);
});

test('lintPlan: 全角数字の手順参照も検査する', () => {
  const plan = mkPlan();
  plan.groups[1].cases[0].steps[1].content = 'No.０９ の結果を確認する';
  assert.equal(byCode(lintPlan(plan), 'ref-step').length, 1);
});

test('lintPlan: 定義した名称が以降で未使用なら warn', () => {
  const plan = mkPlan();
  plan.groups[1].cases[0].steps[0].content = '面談結果を追加する'; // 受入企業A を使わない
  plan.groups[2].cases[0].steps[0].content = 'テストデータを削除する';
  const found = byCode(lintPlan(plan), 'defined-name-unused');
  assert.equal(found.length, 1);
  assert.match(found[0].message, /受入企業A/);
});

test('lintPlan: 「以下、それぞれ「A」「B」とする」の複数定義を拾う', () => {
  const plan = mkPlan();
  plan.groups[0].cases[0].steps[0].content = '受入企業を2社作成する（以下、それぞれ「企業A」「企業B」とする）';
  plan.groups[1].cases[0].steps[0].content = '「企業A」を選択する'; // 企業B は未使用
  plan.groups[2].cases[0].steps[0].content = '企業Aと企業Bを削除する';
  // 企業B は group2（後片付け）で使われているので未使用にならない
  assert.equal(byCode(lintPlan(plan), 'defined-name-unused').length, 0);
});

test('lintPlan: 後片付けグループがなければ warn', () => {
  const plan = mkPlan();
  plan.groups[2] = { no: '02', title: '追加確認', cases: [{ steps: [{ content: '画面を確認する', expected: '表示される' }] }] };
  assert.ok(codes(lintPlan(plan)).includes('cleanup-missing'));
});

test('lintPlan: グループ番号が連番でなければ warn', () => {
  const plan = mkPlan();
  plan.groups[1].no = '05';
  const found = byCode(lintPlan(plan), 'numbering');
  assert.equal(found.length, 1);
  assert.match(found[0].message, /"01" のはずが "05"/);
});

test('lintPlan: siteUrl / prodSiteUrl 未設定は warn', () => {
  const findings = lintPlan(mkPlan({ siteUrl: undefined, prodSiteUrl: undefined }));
  assert.equal(byCode(findings, 'url-missing').length, 2);
});

test('lintPlan: example.com 以外のメールアドレスは error（ダミーメール規約）', () => {
  const plan = mkPlan();
  plan.groups[1].cases[0].steps[0].content = 'taro@company.invalid でログインする';
  const found = byCode(lintPlan(plan), 'dummy-email');
  assert.equal(found.length, 1);
  assert.equal(found[0].level, 'error');
  // サブドメイン付き example.com は許容
  plan.groups[1].cases[0].steps[0].content = 'taro@test.example.com でログインする';
  assert.equal(byCode(lintPlan(plan), 'dummy-email').length, 0);
});

test('lintPlan: 表記揺れ（受入企業/受け入れ企業の混在）は warn', () => {
  const plan = mkPlan();
  plan.groups[1].cases[0].steps[0].content = '「受け入れ企業A」を選択して面談結果を追加する';
  const found = byCode(lintPlan(plan), 'terminology');
  assert.equal(found.length, 1);
  assert.match(found[0].message, /受け入れ企業/);
  assert.match(found[0].message, /受入企業/);
});

test('lintPlan: 単一表記なら terminology 警告なし', () => {
  assert.equal(byCode(lintPlan(mkPlan()), 'terminology').length, 0);
});

// --- 文章規約（読者は非エンジニアのテスト実施者）---

// 手順文を1つ差し替えて、その文に対する指摘だけを取り出すヘルパー
const lintContent = (content, code) => {
  const plan = mkPlan();
  plan.groups[1].cases[0].steps[0].content = content;
  return byCode(lintPlan(plan), code);
};

test('lintPlan: 実装の概念名（Group00 Step04 / precondition / case）は error', () => {
  const found = lintContent('【Group 全体 precondition】Group00 Step04 で確認したテンプレを case1 で使う', 'wording-concept');
  assert.equal(found.length, 1);
  assert.equal(found[0].level, 'error');
  for (const hit of ['precondition', 'Group00', 'Step04', 'case1']) {
    assert.match(found[0].message, new RegExp(hit));
  }
  assert.match(found[0].message, /手順00 No\.04/);
});

test('lintPlan: 「手順00 No.04」形式の参照は error にしない', () => {
  assert.equal(lintContent('手順00 No.01 で登録したテンプレートを選択する', 'wording-concept').length, 0);
});

test('lintPlan: 内部識別子らしき英語は error', () => {
  const found = lintContent('氏名欄に formatForeignerDisplayName が反映される', 'wording-identifier');
  assert.equal(found.length, 1);
  assert.equal(found[0].level, 'error');
  assert.match(found[0].message, /formatForeignerDisplayName/);
});

test('lintPlan: 略語・ファイル名・URL・全大文字のテストデータは識別子と誤検出しない', () => {
  const safe = 'https://stg.example.com/ を開き、users_register.csv を UTF-8 の CSV として保存し、'
    + 'PDF と Excel の帳票を /foreigner/add/many から出力して「NICK FIFTY JIRO」を確認する';
  assert.equal(lintContent(safe, 'wording-identifier').length, 0);
  assert.equal(lintContent(safe, 'wording-concept').length, 0);
});

test('lintPlan: 後始末を実施者任せにする表現は error', () => {
  const found = lintContent('削除は開発側の判断に委ねる（本仕様書のスコープ外）', 'wording-escape');
  assert.equal(found.length, 1);
  assert.equal(found[0].level, 'error');
  assert.match(found[0].message, /判断に委ねる/);
  assert.match(found[0].message, /スコープ外/);
});

test('lintPlan: 環境依存の場合分けは error（理由が挟まる書き方も拾う）', () => {
  const cases = [
    'Word 用テンプレが 0 件の場合は本ケースをスキップする',
    'テンプレの内訳は環境の投入状況に依存する',
    '進めなかった場合は レコードが無いため削除不要',
  ];
  for (const c of cases) {
    const found = lintContent(c, 'wording-env-dependent');
    assert.equal(found.length, 1, `検出されるべき: ${c}`);
    assert.equal(found[0].level, 'error');
  }
});

test('lintPlan: 規約に準拠した手順文では文章規約の error は出ない', () => {
  const plan = mkPlan();
  const wordingCodes = ['wording-concept', 'wording-identifier', 'wording-escape', 'wording-env-dependent'];
  assert.deepEqual(lintPlan(plan).filter((f) => wordingCodes.includes(f.code)), []);
});

test('lintPlan: 中間グループに expected が1つもなければ warn', () => {
  const plan = mkPlan();
  plan.groups[1].cases[0].steps[1].expected = undefined;
  const found = byCode(lintPlan(plan), 'no-expected');
  assert.equal(found.length, 1);
});
