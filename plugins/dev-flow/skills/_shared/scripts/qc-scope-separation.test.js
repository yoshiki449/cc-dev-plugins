#!/usr/bin/env node
'use strict';

// QCフェーズの指摘スコープ分離（Issue #52）のドリフト検出。
// 実行: node --test plugins/dev-flow/skills/_shared/scripts/qc-scope-separation.test.js
//
// Code-Reviewer が返す「参考所見（対応不要）」を dev-self-review の総合判定
// （合格/条件付き合格/不合格）から除外する、という合否ロジックを固定する。
// このリポジトリの規約（プロジェクト CLAUDE.md「ドキュメントを検査するテストは、
// 挙動を決めている行そのものを固定する」）に従い、正準の1文を厳密一致で pin する。
// 語の存在チェックだけだと、この規則を反転（例:「参考所見も件数に含める」）しても
// 通ってしまう。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const AGENTS = path.join(__dirname, '..', '..', '..', 'agents');
const DEV_SELF_REVIEW_MD = path.join(__dirname, '..', '..', 'dev-self-review', 'SKILL.md');
const TEMPLATE_MD = path.join(
  __dirname,
  '..',
  '..',
  'dev-self-review',
  'reference',
  'integrated-report-template.md'
);
const DEV_QA_MD = path.join(__dirname, '..', '..', 'dev-qa', 'SKILL.md');
const CODE_REVIEWER_MD = path.join(AGENTS, 'Code-Reviewer.md');

const read = (p) => fs.readFileSync(p, 'utf8');

test('AC1: Code-Reviewer.md が参考所見を合否判定から除外する旨を明記している', () => {
  const md = read(CODE_REVIEWER_MD);
  assert.match(
    md,
    /\*\*参考所見（対応不要）\*\*:.*今回の変更の合否判定には含めず/,
    'Code-Reviewer.md から「参考所見は合否判定に含めない」の一文が失われている'
  );
});

test('AC2: dev-self-review/SKILL.md S4 が参考所見を総合判定の集計から除外する旨を明記している', () => {
  const md = read(DEV_SELF_REVIEW_MD);
  assert.match(
    md,
    /\*\*参考所見の分離\*\*:.*総合判定（合格\/条件付き合格\/不合格）には数えない/,
    'dev-self-review/SKILL.md S4 から「参考所見は総合判定に数えない」の一文が失われている'
  );
});

test('AC3: integrated-report-template.md が参考所見を件数に含めない旨を明記している', () => {
  const md = read(TEMPLATE_MD);
  assert.match(
    md,
    /\*\*参考所見は上記の件数に含めない。\*\*/,
    'integrated-report-template.md から「参考所見は件数に含めない」の一文が失われている'
  );
  assert.match(md, /## 参考所見（対応不要・今回のPRの合否には含めない）/, '「参考所見」節が失われている');
});

test('AC4: dev-qa/SKILL.md の起因列が表示区分に留まり重要度・総合判定に使わない旨を明記している', () => {
  const md = read(DEV_QA_MD);
  assert.match(
    md,
    /\*\*表示区分であり、総合判定・重要度の算出には使わない。\*\*/,
    'dev-qa/SKILL.md から「起因は表示区分に留める」の一文が失われている'
  );
});
