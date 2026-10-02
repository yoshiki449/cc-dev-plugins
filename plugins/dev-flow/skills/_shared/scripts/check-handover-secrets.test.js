#!/usr/bin/env node
'use strict';

// check-handover-secrets.sh のテスト。
// 実行: node --test plugins/dev-flow/skills/_shared/scripts/check-handover-secrets.test.js
//
// 引継書はリポジトリに追跡される（クラウドセッションが新しい clone だけで前のフェーズの文脈を読むため）。
// コミットされた資格情報は history に残りローテーションが必要になるので、書いた直後に走査する。
// 守る対象は「資格情報らしい行を検出する」と「検出した値そのものを出力しない」の2つ。
// 後者は、走査結果がターミナルやログに残って、結局値が漏れることを防ぐ。

const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.join(__dirname, 'check-handover-secrets.sh');

function run(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-handover-'));
  const file = path.join(dir, 'handover.md');
  fs.writeFileSync(file, content);
  const r = spawnSync('bash', [SCRIPT, file], { encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
  return { status: r.status, out: r.stdout + r.stderr };
}

// 値に当たる部分。出力に現れてはいけない
const SECRET = 'S3cr3tValue9xQ';

const DETECTED = [
  ['パスワードの代入（半角コロン）', `- パスワード: ${SECRET}`],
  ['パスワードの代入（全角コロン）', `- パスワード：${SECRET}`],
  ['password の代入（等号・大文字小文字無視）', `Password=${SECRET}`],
  ['環境変数名のパスワード', `DB_PASSWORD=${SECRET}`],
  ['トークンの代入', `- token: ${SECRET}`],
  ['API キーの代入（アンダースコア）', `api_key = ${SECRET}`],
  ['シークレットの代入', `client_secret: ${SECRET}`],
  ['Bearer トークン', `Authorization: Bearer ${'a'.repeat(20)}${SECRET}`],
  ['URL に埋め込まれた資格情報', `postgres://admin:${SECRET}@db.example.com/app`],
  ['GitHub トークンの接頭辞', `ghp_${'A'.repeat(30)}`],
  ['秘密鍵', '-----BEGIN RSA PRIVATE KEY-----'],
];

const ALLOWED = [
  ['プレースホルダ（山括弧）', '- パスワード: <書かない>'],
  ['パスワードは書かない旨の説明', '- ログインユーザー: user@example.com（パスワードは .env.local を参照）'],
  ['値を持たない見出し', '## パスワードの扱い'],
  ['コミットの SHA（40桁の16進）', '- コミット: 0ac1a1c9f3e8b7d6a5c4b3a2918d7e6f5a4b3c2d'],
  ['トークンという語を含むだけの文', '- トークンの有効期限は 1 時間（値は含まない）'],
  ['空の代入', 'token:'],
  ['省略記号', 'password: …'],
  ['パスの文字列', '- 設定: scripts/setup-env.sh（.env を作る）'],
  ['URL（資格情報なし）', '- 起動URL: http://localhost:3000/login'],
];

for (const [name, line] of DETECTED) {
  test(`検出する: ${name}`, () => {
    const r = run(`# 引継書\n\n${line}\n`);
    assert.strictEqual(r.status, 1, `exit 1 のはずが ${r.status}\n${r.out}`);
  });
}

for (const [name, line] of ALLOWED) {
  test(`検出しない: ${name}`, () => {
    const r = run(`# 引継書\n\n${line}\n`);
    assert.strictEqual(r.status, 0, `誤検出: ${r.out}`);
    assert.strictEqual(r.out.trim(), '', '何も出力しない');
  });
}

test('検出した値そのものを出力しない', () => {
  const r = run(`- パスワード: ${SECRET}\n`);
  assert.strictEqual(r.status, 1);
  assert.ok(!r.out.includes(SECRET), `値が出力に漏れている: ${r.out}`);
});

test('検出箇所を「ファイル:行番号」で示す', () => {
  const r = run(`# 引継書\n\n- ok\n- パスワード: ${SECRET}\n`);
  assert.match(r.out, /:4:/, `4行目を示す: ${r.out}`);
});

test('複数の検出をすべて示す', () => {
  const r = run(`token: ${SECRET}\n\nDB_PASSWORD=${SECRET}\n`);
  assert.match(r.out, /:1:/);
  assert.match(r.out, /:3:/);
});

test('引数が無ければ exit 2', () => {
  const r = spawnSync('bash', [SCRIPT], { encoding: 'utf8' });
  assert.strictEqual(r.status, 2);
});

test('ファイルが無ければ exit 2（検出なしの exit 0 と区別する）', () => {
  const r = spawnSync('bash', [SCRIPT, '/nonexistent/handover.md'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 2);
});
