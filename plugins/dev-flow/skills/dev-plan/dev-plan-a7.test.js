// dev-plan A7 の投稿先分岐（#71）。既存 Issue から入ったときに create してしまうと同じ欠陥の Issue が2つできる。
// マーカーで囲んだ行そのものを検査する（語の存在チェックは指示を反転しても通る）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const md = fs.readFileSync(path.join(__dirname, 'SKILL.md'), 'utf8');
const m = md.match(/<!-- dev-plan:a7-post -->\n([\s\S]*?)\n<!-- \/dev-plan:a7-post -->/);

test('A7: 投稿先が新規と既存で分岐している', () => {
  assert.ok(m, 'a7-post マーカーが見つからない');
  const lines = m[1].split('\n').filter((l) => /^- /.test(l));
  assert.equal(lines.length, 2, '分岐は新規・既存の2行のはず');
  assert.match(lines[0], /^- \*\*新規.*\*\*: `gh issue create --body-file -`/);
  assert.match(lines[1], /^- \*\*既存 Issue.*\*\*: `gh issue edit <番号> --body-file -`/);
  assert.match(lines[1], /`method: update`/);
  assert.match(lines[1], /\*\*`create` してはならない\*\*/);
});

test('A7: 既存 Issue の全面置換・訂正の明示・表題変更の報告を持つ', () => {
  assert.match(m[1], /既存本文は全面置換する。追記やコメントでの補足にしない/);
  assert.match(m[1], /「当初の本文の訂正」として新しい本文の中に明示する/);
  assert.match(m[1], /完了報告に「表題を『旧』から『新』に変更した」と1行書く/);
});

test('A7: 投稿前チェックは新規・既存どちらでも行う', () => {
  assert.match(md, /投稿前チェック（下記）は新規・既存どちらでも/);
});
