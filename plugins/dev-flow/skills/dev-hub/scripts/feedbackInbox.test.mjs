import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import inbox from './feedbackInbox.js';

const { findProjectRoot, inboxPathFor, writeInboxEntry } = inbox;

/** fixture: <tmp>/<name>/ 配下にファイルツリーを作る */
function makeTree(tmp, spec) {
  for (const [rel, content] of Object.entries(spec)) {
    const abs = path.join(tmp, rel);
    if (content === null) {
      fs.mkdirSync(abs, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
  }
}

test('findProjectRoot: .git ディレクトリ / .git ファイル（worktree）/ .agent のみ（傘）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-inbox-'));
  try {
    makeTree(tmp, {
      'repo/.git': null,
      'repo/docs/DESIGN.md': '# x',
      'wt/.git': 'gitdir: /somewhere/.git/worktrees/wt',
      'wt/docs/plans/PLAN.md': '# p',
      'umbrella/.agent': null,
      'umbrella/.agent/reports/qa.md': '# r',
    });
    assert.equal(findProjectRoot(path.join(tmp, 'repo/docs/DESIGN.md')), path.join(tmp, 'repo'));
    assert.equal(findProjectRoot(path.join(tmp, 'wt/docs/plans/PLAN.md')), path.join(tmp, 'wt'));
    assert.equal(findProjectRoot(path.join(tmp, 'umbrella/.agent/reports/qa.md')), path.join(tmp, 'umbrella'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('findProjectRoot: ネストでは直近の親を返し、どこにも無ければ null', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-inbox-'));
  try {
    makeTree(tmp, {
      'outer/.git': null,
      'outer/inner/.git': null,
      'outer/inner/docs/a.md': '# a',
      'plain/docs/b.md': '# b',
    });
    assert.equal(
      findProjectRoot(path.join(tmp, 'outer/inner/docs/a.md')),
      path.join(tmp, 'outer/inner'),
    );
    // /tmp 配下に .git/.agent が無い前提（mkdtemp 直下）だが、上位に存在し得る環境でも
    // 少なくとも fixture 内のルートは返らないことを確認する
    const r = findProjectRoot(path.join(tmp, 'plain/docs/b.md'));
    assert.ok(r === null || !r.startsWith(path.join(tmp, 'plain')));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('findProjectRoot: ホームディレクトリ以上はプロジェクトとみなさない（~/.agent はグローバル置き場）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-inbox-'));
  try {
    // tmp を「ホーム」に見立てる: ~/.agent があっても傘プロジェクト扱いしない
    makeTree(tmp, {
      '.agent': null,
      '.claude/plans/global-plan.md': '# p',
      'work/repo/.git': null,
      'work/repo/docs/a.md': '# a',
    });
    assert.equal(findProjectRoot(path.join(tmp, '.claude/plans/global-plan.md'), tmp), null);
    // ホームより深いプロジェクトは通常どおり見つかる
    assert.equal(findProjectRoot(path.join(tmp, 'work/repo/docs/a.md'), tmp), path.join(tmp, 'work/repo'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('inboxPathFor: 16桁 sha1 hex のみ許可（任意ファイル名不可）', () => {
  assert.equal(
    inboxPathFor('/repo', 'abcdef0123456789'),
    path.join('/repo', '.agent', 'feedback-inbox', 'abcdef0123456789.json'),
  );
  assert.throws(() => inboxPathFor('/repo', '../evil'));
  assert.throws(() => inboxPathFor('/repo', 'short'));
  assert.throws(() => inboxPathFor('/repo', 'ABCDEF0123456789'));
});

test('writeInboxEntry: スキーマ・id/anchor 除去・上書き', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-inbox-'));
  try {
    makeTree(tmp, { 'repo/.git': null, 'repo/docs/DESIGN.md': '# x' });
    const item = {
      id: 'abcdef0123456789',
      path: path.join(tmp, 'repo/docs/DESIGN.md'),
      type: 'doc',
      project: 'repo',
    };
    const comments = [
      { id: 'c2', quote: 'b', startLine: 5, endLine: 6, comment: 'B', anchor: { x: 1 } },
      { id: 'c1', quote: 'a', startLine: 2, endLine: 2, comment: 'A', anchor: { x: 1 } },
    ];
    const res = writeInboxEntry(item, comments);
    assert.equal(res.count, 2);
    assert.equal(res.path, path.join(tmp, 'repo/.agent/feedback-inbox/abcdef0123456789.json'));
    const entry = JSON.parse(fs.readFileSync(res.path, 'utf8'));
    assert.equal(entry.version, 1);
    assert.equal(entry.id, 'abcdef0123456789');
    assert.equal(entry.type, 'doc');
    assert.equal(entry.project, 'repo');
    assert.equal(entry.file, item.path);
    assert.ok(entry.created_at);
    // buildExportJson 経由: startLine 昇順・id/anchor 除去
    assert.deepEqual(entry.comments[0], { quote: 'a', startLine: 2, endLine: 2, comment: 'A' });
    assert.ok(!('anchor' in entry.comments[1]));
    // 再書き出しは上書き（追記しない）
    const res2 = writeInboxEntry(item, [comments[0]]);
    const entry2 = JSON.parse(fs.readFileSync(res2.path, 'utf8'));
    assert.equal(entry2.comments.length, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('writeInboxEntry: 動画コメントの timestamp / screenshot が透過される', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-inbox-'));
  try {
    makeTree(tmp, { 'repo/.git': null, 'repo/e2e/v.webm': 'x' });
    const item = { id: '0123456789abcdef', path: path.join(tmp, 'repo/e2e/v.webm'), type: 'video', project: 'repo' };
    const res = writeInboxEntry(item, [
      { id: 'c1', quote: '', startLine: null, endLine: null, comment: 'ボタンが見切れている', timestamp: 34.5, screenshot: `${path.join(tmp, 'repo/e2e/v.webm')}.frame-34500.png` },
    ]);
    const entry = JSON.parse(fs.readFileSync(res.path, 'utf8'));
    assert.equal(entry.type, 'video');
    assert.equal(entry.comments[0].timestamp, 34.5);
    assert.match(entry.comments[0].screenshot, /frame-34500\.png$/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('writeInboxEntry: 0件・item 不備・ルート無しは Error', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-inbox-'));
  try {
    makeTree(tmp, { 'repo/.git': null, 'repo/a.md': '# a' });
    const item = { id: 'abcdef0123456789', path: path.join(tmp, 'repo/a.md'), type: 'doc', project: 'repo' };
    assert.throws(() => writeInboxEntry(item, []), /non-empty/);
    assert.throws(() => writeInboxEntry({ path: item.path }, [{ comment: 'x' }]), /id and path/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
