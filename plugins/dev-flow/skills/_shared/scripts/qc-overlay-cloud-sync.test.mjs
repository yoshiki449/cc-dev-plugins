// 実行: node --test plugins/dev-flow/skills/_shared/scripts/qc-overlay-cloud-sync.test.mjs
//
// クラウドセッションで、同じセッションに付けた別リポジトリ内の QC overlay を
// ~/.cc-plugins/overlay/qc/ へ自動同期するスクリプト（render_qc_overlay_snippet.sh の
// 代替方式）。セッション開始時に毎回動くことを想定し、対象が見つからなくても失敗にしない
// 挙動と、0バイト manifest.json を候補として数えない安全策を中心に検証する。

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'qc-overlay-cloud-sync.sh');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeRepo(dir, subpath, files) {
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  const overlayDir = path.join(dir, subpath);
  fs.mkdirSync(overlayDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(overlayDir, name), content);
  }
}

function run({ root, home, subpath, destDir }) {
  const env = { ...process.env, CLOUD_STACK_ROOT: root, HOME: home };
  if (subpath !== undefined) env.CC_PLUGINS_OVERLAY_SOURCE_SUBPATH = subpath;
  else delete env.CC_PLUGINS_OVERLAY_SOURCE_SUBPATH;
  if (destDir) env.CC_PLUGINS_OVERLAY_DIR = destDir;
  return spawnSync('bash', [SCRIPT], { encoding: 'utf8', env });
}

const SUBPATH = 'plugins/proseeds-overlay/overlay/qc';

test('CC_PLUGINS_OVERLAY_SOURCE_SUBPATH 未設定なら何もせず exit 0', () => {
  const root = tempDir('qc-sync-off-');
  const home = tempDir('qc-sync-off-home-');
  const r = run({ root, home, subpath: undefined });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(path.join(home, '.cc-plugins', 'overlay', 'qc')), false);
});

test('候補が無い（.git はあるがサブパスに manifest.json が無い）となにもコピーせず理由をログに残す', () => {
  const root = tempDir('qc-sync-nocand-');
  fs.mkdirSync(path.join(root, 'other-repo', '.git'), { recursive: true });
  const home = tempDir('qc-sync-nocand-home-');
  const r = run({ root, home, subpath: SUBPATH });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(path.join(home, '.cc-plugins', 'overlay', 'qc')), false);
  const log = fs.readFileSync(path.join(home, '.cc-plugins', '.overlay-sync.log'), 'utf8');
  assert.match(log, /見つからない/);
});

test('候補が1件なら manifest.json とフェーズファイルがバイト単位一致でコピーされ、権限も設定される', () => {
  const root = tempDir('qc-sync-one-');
  const files = {
    'manifest.json': '{"name":"テスト","reviewer_agent":"acme:qc-reviewer"}\n',
    'plan.md': '- 観点1\n- バックティック: `echo hi`\n',
    'ship.md': '末尾に改行の無いファイル',
  };
  makeRepo(path.join(root, 'cc-plugins'), SUBPATH, files);
  const home = tempDir('qc-sync-one-home-');
  const r = run({ root, home, subpath: SUBPATH });
  assert.equal(r.status, 0, r.stderr);

  const destDir = path.join(home, '.cc-plugins', 'overlay', 'qc');
  for (const [name, content] of Object.entries(files)) {
    assert.deepEqual(fs.readFileSync(path.join(destDir, name)), Buffer.from(content, 'utf8'), `${name} が一致しない`);
    assert.equal(fs.statSync(path.join(destDir, name)).mode & 0o777, 0o600, `${name} の権限が600でない`);
  }
  assert.equal(fs.statSync(destDir).mode & 0o777, 0o700, 'ディレクトリの権限が700でない');
});

test('わざと壊す: 0バイトの manifest.json は候補として数えない', () => {
  const root = tempDir('qc-sync-empty-');
  makeRepo(path.join(root, 'cc-plugins'), SUBPATH, { 'manifest.json': '', 'plan.md': '- 観点\n' });
  const home = tempDir('qc-sync-empty-home-');
  const r = run({ root, home, subpath: SUBPATH });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(path.join(home, '.cc-plugins', 'overlay', 'qc')), false, '0バイトmanifestを候補にしてしまっている');
  const log = fs.readFileSync(path.join(home, '.cc-plugins', '.overlay-sync.log'), 'utf8');
  assert.match(log, /見つからない/);
});

test('候補が複数件なら sort で決定的に1つを選び、選ばれなかった側もログに残す', () => {
  const root = tempDir('qc-sync-multi-');
  makeRepo(path.join(root, 'repo-a'), SUBPATH, { 'manifest.json': '{"from":"a"}\n' });
  makeRepo(path.join(root, 'repo-b'), SUBPATH, { 'manifest.json': '{"from":"b"}\n' });
  const home = tempDir('qc-sync-multi-home-');
  const r = run({ root, home, subpath: SUBPATH });
  assert.equal(r.status, 0, r.stderr);

  const destManifest = fs.readFileSync(path.join(home, '.cc-plugins', 'overlay', 'qc', 'manifest.json'), 'utf8');
  const expectedChosen = [path.join(root, 'repo-a'), path.join(root, 'repo-b')].sort()[0];
  assert.equal(destManifest, expectedChosen.endsWith('repo-a') ? '{"from":"a"}\n' : '{"from":"b"}\n');

  const log = fs.readFileSync(path.join(home, '.cc-plugins', '.overlay-sync.log'), 'utf8');
  assert.match(log, /候補が複数/);
});

test('既存の宛先ファイルは新しい内容で上書きされる（前回セッションの残骸を想定）', () => {
  const root = tempDir('qc-sync-overwrite-');
  makeRepo(path.join(root, 'cc-plugins'), SUBPATH, { 'manifest.json': '{"v":2}\n' });
  const home = tempDir('qc-sync-overwrite-home-');
  const destDir = path.join(home, '.cc-plugins', 'overlay', 'qc');
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(path.join(destDir, 'manifest.json'), '{"v":1,"stale":true}\n');

  const r = run({ root, home, subpath: SUBPATH });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(destDir, 'manifest.json'), 'utf8'), '{"v":2}\n');
});

test('CC_PLUGINS_OVERLAY_DIR で宛先を上書きできる', () => {
  const root = tempDir('qc-sync-destoverride-');
  makeRepo(path.join(root, 'cc-plugins'), SUBPATH, { 'manifest.json': '{}\n' });
  const home = tempDir('qc-sync-destoverride-home-');
  const customDest = path.join(tempDir('qc-sync-customdest-'), 'qc');

  const r = run({ root, home, subpath: SUBPATH, destDir: customDest });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(path.join(customDest, 'manifest.json')), true);
  assert.equal(fs.existsSync(path.join(home, '.cc-plugins', 'overlay', 'qc', 'manifest.json')), false);
});

test('存在しないフェーズファイルはコピーされない', () => {
  const root = tempDir('qc-sync-partial-');
  makeRepo(path.join(root, 'cc-plugins'), SUBPATH, { 'manifest.json': '{}\n', 'qa.md': '- 観点\n' });
  const home = tempDir('qc-sync-partial-home-');
  const r = run({ root, home, subpath: SUBPATH });
  assert.equal(r.status, 0, r.stderr);
  const destDir = path.join(home, '.cc-plugins', 'overlay', 'qc');
  assert.equal(fs.existsSync(path.join(destDir, 'manifest.json')), true);
  assert.equal(fs.existsSync(path.join(destDir, 'qa.md')), true);
  for (const absent of ['plan.md', 'impl.md', 'test-spec.md', 'verify.md', 'ship.md', 'test-model.md']) {
    assert.equal(fs.existsSync(path.join(destDir, absent)), false, `${absent} が存在してはいけない`);
  }
});
