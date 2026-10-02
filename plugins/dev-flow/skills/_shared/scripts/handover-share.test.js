#!/usr/bin/env node
'use strict';

// 引継書の共有手順（handover-template.md の正準ブロック）が、実際の仕組みと食い違わないことを固定する。
// 実行: node --test plugins/dev-flow/skills/_shared/scripts/handover-share.test.js
//
// 語の存在だけを見るテストは、手順を反転しても通る（例: 「コミットしない」を「コミットする」に書き換えても
// 「コミット」の語は残る）。そこで、挙動を決めている行そのものをマーカーで囲んで読み出し、
// その行が指す実体（スクリプト・コマンド）が存在し、順序が保たれていることを確かめる。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SHARED = path.join(__dirname, '..');
const TEMPLATE = fs.readFileSync(path.join(SHARED, 'reference', 'handover-template.md'), 'utf8');

function block() {
  const m = TEMPLATE.match(/<!-- handover-share:steps -->\n([\s\S]*?)<!-- \/handover-share:steps -->/);
  assert.ok(m, 'handover-template.md に handover-share:steps のマーカーがある');
  return m[1];
}

test('正準ブロックは3つの手順を、走査 → 無視判定 → コミットの順で持つ', () => {
  const b = block();
  const scan = b.indexOf('check-handover-secrets.sh');
  const ignore = b.indexOf('git check-ignore -q');
  const commit = b.indexOf('git commit');
  assert.ok(scan >= 0 && ignore >= 0 && commit >= 0, '走査・無視判定・コミットの3つが揃う');
  assert.ok(scan < ignore && ignore < commit, '走査 → 無視判定 → コミットの順');
});

test('走査の失敗（exit 1）でコミットしない旨を、コミットより前に書く', () => {
  const b = block();
  const guard = b.indexOf('通るまでコミットしない');
  assert.ok(guard >= 0, '走査が通るまでコミットしない、と書いてある');
  assert.ok(guard < b.indexOf('git commit'), 'その行はコミットの手順より前にある');
});

test('コミットは引継書の1ファイルだけ（pathspec コミットにせず、ステージ済みの巻き込みを確認する）', () => {
  const b = block();
  assert.ok(b.includes('git add <引継書のパス>'));
  assert.ok(b.includes('git diff --cached --name-only'), '他のステージ済み変更を巻き込まないことを確認する');
  // doc-standard が警告している pathspec コミット（git commit -- <path>）は、index の削除を落とす
  assert.ok(!/git commit[^\n]*--\s+</.test(b), 'pathspec 付きの git commit を勧めない');
});

test('正準ブロックが指すスクリプトが実在し、実行できる', () => {
  const m = block().match(/<skill-dir>\/\.\.\/_shared\/scripts\/(check-handover-secrets\.sh)/);
  assert.ok(m, 'スクリプトのパスは <skill-dir>/../_shared/scripts/ の形で書く');
  const script = path.join(SHARED, 'scripts', m[1]);
  assert.ok(fs.existsSync(script), `${m[1]} が存在する`);
  const r = spawnSync('bash', [script], { encoding: 'utf8' });
  assert.strictEqual(r.status, 2, '引数なしは使い方の誤り（exit 2）');
});

test('テンプレートはログイン情報にパスワードを書かせない', () => {
  assert.ok(!TEMPLATE.includes('<メール/パスワード>'), '「メール/パスワード」の欄が残っていない');
  assert.match(TEMPLATE, /パスワード・トークンは書かない/);
});

test('走査スクリプトは README の一覧にある', () => {
  const readme = fs.readFileSync(path.join(SHARED, 'README.md'), 'utf8');
  assert.ok(readme.includes('scripts/check-handover-secrets.sh'));
});

test('doc-standard は、引継書を追跡する allowlist を、gitignore のコード例として案内する', () => {
  const doc = fs.readFileSync(path.join(SHARED, '..', 'doc-standard', 'SKILL.md'), 'utf8');
  // 地の文の言及では足りない。利用者が貼る gitignore のコードブロックそのものを見る
  const blocks = [...doc.matchAll(/```gitignore\n([\s\S]*?)```/g)].map((m) => m[1].split('\n'));
  const found = blocks.find((lines) => lines.includes('!.agent/handover-*.md'));
  assert.ok(found, '!.agent/handover-*.md を含む gitignore のコード例がある');
  assert.ok(found.includes('.agent/*'), '既定除外は .agent/* の形（.agent/ の1行だと例外が効かない）');
  assert.ok(!found.includes('.agent/'), '.agent/ の1行を併記しない');
  assert.ok(found.indexOf('.agent/*') < found.indexOf('!.agent/handover-*.md'), '例外は既定除外より後ろに書く');
});
