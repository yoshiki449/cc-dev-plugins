#!/usr/bin/env node
'use strict';

// resolve-base-ref.sh のテスト（Issue #12 の E1〜E8 を一時リポジトリで再現する）。
// 実行: node --test plugins/dev-flow/skills/_shared/scripts/resolve-base-ref.test.js
//
// origin はネットワーク先ではなく、ローカルの ref（refs/remotes/origin/*）を update-ref で
// 直接作って表現する。fetch の挙動だけは bare リポジトリを origin にして別テストで確かめる。
// gh は PATH 先頭に置いたスタブで差し替える（実 gh・実 GitHub には触れない）。

const test = require('node:test');
const assert = require('node:assert');
const { spawnSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.join(__dirname, 'resolve-base-ref.sh');

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

function git(dir, args) {
  return execFileSync('git', args, { cwd: dir, env: GIT_ENV, encoding: 'utf8' }).trim();
}

function tmp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function initRepo(t, branch = 'work') {
  const dir = tmp(t, 'resolve-base-');
  git(dir, ['init', '-q']);
  git(dir, ['checkout', '-q', '-b', branch]);
  git(dir, ['config', 'user.name', 'Test User']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  return dir;
}

let seq = 0;
function commit(dir, message = 'c') {
  seq += 1;
  fs.writeFileSync(path.join(dir, `f${seq}.txt`), `${seq}\n`);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']);
}

function setRemoteRef(dir, name, sha) {
  git(dir, ['update-ref', `refs/remotes/origin/${name}`, sha]);
}

// gh スタブ。stdout に baseRefName を返す（output=null なら失敗終了）。
function ghStubDir(t, output) {
  const bin = tmp(t, 'gh-stub-');
  const body = output === null ? 'exit 1' : `printf '%s\\n' '${output}'`;
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return bin;
}

// gh を完全に見えなくする PATH（bash と git と coreutils は残す）。
function envWithoutGh(t) {
  const bin = tmp(t, 'nogh-bin-');
  for (const cmd of ['bash', 'git', 'timeout', 'sed', 'cat', 'dirname', 'env']) {
    const found = spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' }).stdout.trim();
    if (found) fs.symlinkSync(found, path.join(bin, cmd));
  }
  return { ...GIT_ENV, PATH: bin };
}

function run(args, env = GIT_ENV) {
  return spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env,
    cwd: os.tmpdir(),
  });
}

function parse(res, expectStatus = 0) {
  assert.equal(res.status, expectStatus, `終了コード ${expectStatus} を期待: ${res.status} / stderr: ${res.stderr}`);
  const lines = res.stdout.trim().split('\n');
  assert.equal(lines.length, 1, `stdout は JSON 1行のみ: ${JSON.stringify(res.stdout)}`);
  return JSON.parse(lines[0]);
}

function noGhEnv(t) {
  return envWithoutGh(t);
}

test('E1: 最短距離で選ぶ（develop から3コミット先、main からは268コミット先）', (t) => {
  const dir = initRepo(t);
  const root = commit(dir, 'root');
  setRemoteRef(dir, 'main', root);
  // main から離れた develop 側を 265 コミット積む（main は root のまま）
  for (let i = 0; i < 265; i += 1) commit(dir, `dev-${i}`);
  setRemoteRef(dir, 'develop', git(dir, ['rev-parse', 'HEAD']));
  for (let i = 0; i < 3; i += 1) commit(dir, `feat-${i}`);

  const out = parse(run(['--dir', dir, '--no-fetch'], noGhEnv(t)));
  assert.equal(out.base, 'origin/develop');
  assert.equal(out.source, 'nearest');
  const byRef = Object.fromEntries(out.candidates.map((c) => [c.ref, c.ahead]));
  assert.equal(byRef['origin/develop'], 3);
  assert.equal(byRef['origin/main'], 268);
});

test('E2: ローカルの main は候補にしない（origin/main より古いローカル main があっても origin/main）', (t) => {
  const dir = initRepo(t, 'main'); // ローカル main = 古い
  const stale = commit(dir, 'stale');
  for (let i = 0; i < 6; i += 1) commit(dir, `adv-${i}`);
  setRemoteRef(dir, 'main', git(dir, ['rev-parse', 'HEAD']));
  git(dir, ['checkout', '-q', '-b', 'feature']);
  commit(dir, 'f1');
  commit(dir, 'f2');
  git(dir, ['branch', '-f', 'main', stale]);

  const out = parse(run(['--dir', dir, '--no-fetch'], noGhEnv(t)));
  assert.equal(out.base, 'origin/main');
  assert.ok(out.candidates.every((c) => !/^main$/.test(c.ref)), 'ローカルの main が候補に入っている');
});

test('E3: 同数なら先頭（origin/develop）を採る', (t) => {
  const dir = initRepo(t);
  const root = commit(dir, 'root');
  setRemoteRef(dir, 'develop', root);
  setRemoteRef(dir, 'main', root);
  commit(dir, 'f1');

  const out = parse(run(['--dir', dir, '--no-fetch'], noGhEnv(t)));
  assert.equal(out.base, 'origin/develop');
});

test('E3b: origin/HEAD が設定されていれば同数のとき最優先', (t) => {
  const dir = initRepo(t);
  const root = commit(dir, 'root');
  setRemoteRef(dir, 'develop', root);
  setRemoteRef(dir, 'main', root);
  git(dir, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  commit(dir, 'f1');

  const out = parse(run(['--dir', dir, '--no-fetch'], noGhEnv(t)));
  assert.equal(out.base, 'origin/main');
});

test('E4: 既存 PR の base を優先（候補に無い release/1.2 でも採る）', (t) => {
  const dir = initRepo(t);
  const root = commit(dir, 'root');
  setRemoteRef(dir, 'main', root);
  setRemoteRef(dir, 'release/1.2', root);
  commit(dir, 'f1');
  const bin = ghStubDir(t, 'release/1.2');

  const out = parse(run(['--dir', dir, '--no-fetch'], { ...GIT_ENV, PATH: `${bin}:${process.env.PATH}` }));
  assert.equal(out.base, 'origin/release/1.2');
  assert.equal(out.source, 'pr');
});

test('E4b: PR の base が origin に無ければ警告して最短距離にフォールバック', (t) => {
  const dir = initRepo(t);
  const root = commit(dir, 'root');
  setRemoteRef(dir, 'main', root);
  commit(dir, 'f1');
  const bin = ghStubDir(t, 'release/9.9');

  const out = parse(run(['--dir', dir, '--no-fetch'], { ...GIT_ENV, PATH: `${bin}:${process.env.PATH}` }));
  assert.equal(out.base, 'origin/main');
  assert.equal(out.source, 'nearest');
  assert.ok(out.warnings.some((w) => w.includes('release/9.9')));
});

test('E5: gh が無い・PR が無い（gh 失敗）なら最短距離で決める', (t) => {
  const dir = initRepo(t);
  const root = commit(dir, 'root');
  setRemoteRef(dir, 'main', root);
  commit(dir, 'f1');

  const noGh = parse(run(['--dir', dir, '--no-fetch'], noGhEnv(t)));
  assert.equal(noGh.base, 'origin/main');
  assert.equal(noGh.source, 'nearest');

  const bin = ghStubDir(t, null);
  const noPr = parse(run(['--dir', dir, '--no-fetch'], { ...GIT_ENV, PATH: `${bin}:${process.env.PATH}` }));
  assert.equal(noPr.base, 'origin/main');
  assert.equal(noPr.source, 'nearest');
});

test('E6: 候補が1つも無ければ終了コード2で中断し、main へ黙って落ちない', (t) => {
  const dir = initRepo(t, 'main'); // ローカル main はある。それでも採ってはいけない
  commit(dir, 'root');
  commit(dir, 'f1');

  const out = parse(run(['--dir', dir, '--no-fetch'], noGhEnv(t)), 2);
  assert.equal(out.base, null);
  assert.ok(out.error);
});

test('E7: --base に存在しない ref は終了コード2', (t) => {
  const dir = initRepo(t);
  commit(dir, 'root');
  const out = parse(run(['--dir', dir, '--base', 'origin/nope', '--no-fetch'], noGhEnv(t)), 2);
  assert.equal(out.base, null);
});

test('E7b: --base に実在する ref は source=explicit でそのまま返す', (t) => {
  const dir = initRepo(t);
  const root = commit(dir, 'root');
  commit(dir, 'f1');
  const out = parse(run(['--dir', dir, '--base', root, '--no-fetch'], noGhEnv(t)));
  assert.equal(out.base, root);
  assert.equal(out.source, 'explicit');
});

test('--base / --head にオプション風の値（--output=…）を渡しても git に解釈されない', (t) => {
  const dir = initRepo(t);
  commit(dir, 'root');
  const target = path.join(tmp(t, 'inj-'), 'pwned');
  const a = parse(run(['--dir', dir, '--base', `--output=${target}`, '--no-fetch'], noGhEnv(t)), 2);
  assert.equal(a.base, null);
  const b = parse(run(['--dir', dir, '--head', `--output=${target}`, '--no-fetch'], noGhEnv(t)), 2);
  assert.equal(b.base, null);
  assert.equal(fs.existsSync(target), false, '--output= が git に解釈されてファイルが作られた');
});

test('シェルの特殊文字を含む ref 名でも動作が変わらない', (t) => {
  const dir = initRepo(t);
  const root = commit(dir, 'root');
  git(dir, ['update-ref', 'refs/heads/a;b&c$d', root]);
  const out = parse(run(['--dir', dir, '--base', 'a;b&c$d', '--no-fetch'], noGhEnv(t)));
  assert.equal(out.base, 'a;b&c$d');
});

test('git fetch origin で追跡ブランチを新しくしてから決める（既定）。--no-fetch なら古いまま', (t) => {
  const remote = tmp(t, 'remote-');
  git(remote, ['init', '-q', '--bare', '-b', 'main']);
  const dir = initRepo(t);
  git(dir, ['remote', 'add', 'origin', remote]);
  const root = commit(dir, 'root');
  git(dir, ['push', '-q', 'origin', `${root}:refs/heads/main`]);
  git(dir, ['fetch', '-q', 'origin']);
  // origin/main だけが先へ進み、ローカルの追跡ブランチは古いまま
  const work = commit(dir, 'f1');
  git(dir, ['push', '-q', 'origin', `${work}:refs/heads/main`]);
  setRemoteRef(dir, 'main', root); // push は追跡ブランチも進めるので、古い状態に巻き戻す
  commit(dir, 'f2');

  const stale = parse(run(['--dir', dir, '--no-fetch'], noGhEnv(t)));
  assert.equal(stale.candidates.find((c) => c.ref === 'origin/main').ahead, 2);
  const fresh = parse(run(['--dir', dir], noGhEnv(t)));
  assert.equal(fresh.candidates.find((c) => c.ref === 'origin/main').ahead, 1);
  assert.deepEqual(fresh.warnings, []);
});

test('fetch に失敗しても続行し、警告を出す', (t) => {
  const dir = initRepo(t);
  const root = commit(dir, 'root');
  git(dir, ['remote', 'add', 'origin', path.join(os.tmpdir(), 'no-such-remote-dir')]);
  setRemoteRef(dir, 'main', root);
  commit(dir, 'f1');

  const out = parse(run(['--dir', dir], noGhEnv(t)));
  assert.equal(out.base, 'origin/main');
  assert.ok(out.warnings.some((w) => w.includes('fetch')));
});

test('git リポジトリでない・引数不正は終了コード2', (t) => {
  const notRepo = tmp(t, 'notrepo-');
  assert.equal(run(['--dir', notRepo, '--no-fetch']).status, 2);
  assert.equal(run(['--bogus']).status, 2);
});
