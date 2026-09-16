// 実行: node --test plugins/dev-flow/skills/cloud-stack/scripts/cloud-stack.test.mjs
//
// docker / dockerd / npm / npx / curl はスタブにし、架空のリポジトリで manifest 駆動の挙動を固定する。
// スタブの挙動は stubs ディレクトリのファイルで切り替える（下の makeWorld を参照）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cloud-stack.sh');
const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'hooks', 'cloud-session-start.sh');

const BACKEND_DOCKERFILE = `# 本番用
FROM python:3.12-slim AS base
WORKDIR /app
RUN pip install -r requirements.txt

FROM base AS runtime
CMD ["python", "main.py"]
`;
const FRONTEND_DOCKERFILE = `FROM node:20-alpine
RUN npm ci
`;

function manifest(overrides = {}) {
  return {
    // 1つ目は標準入力を読む。準備コマンドの標準入力を閉じないと、後続のコマンドが読み飛ばされる
    prepare: ['cat > /dev/null; echo prepared > .prepared', 'echo second >> .prepared'],
    npm: ['web'],
    playwright: ['e2e'],
    compose: {
      files: ['compose.yml', 'compose.ci.yml'],
      ca_builds: [
        { dockerfile: 'Dockerfile', context: '.', services: ['api', 'worker'] },
        { dockerfile: 'web/Dockerfile', context: 'web', services: ['web'] },
      ],
      pre_up: ['echo pre >> .hooks'],
      post_up: ['echo post >> .hooks'],
    },
    health: { url: 'http://localhost:9999/health', restart_service: 'api', attempts: 2, interval: 0 },
    tests: { unit: 'echo unit-ran >> .tests', e2e: 'echo e2e-ran >> .tests' },
    ...overrides,
  };
}

function gitInit(dir) {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', dir]);
}

function makeRepo(root, name, mf) {
  const repo = path.join(root, name);
  gitInit(repo);
  if (mf) {
    fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.claude', 'cloud-stack.json'), JSON.stringify(mf));
    fs.writeFileSync(path.join(repo, 'Dockerfile'), BACKEND_DOCKERFILE);
    fs.mkdirSync(path.join(repo, 'web'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'web', 'Dockerfile'), FRONTEND_DOCKERFILE);
    fs.mkdirSync(path.join(repo, 'e2e'), { recursive: true });
  }
  return repo;
}

function stub(bin, name, body) {
  fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}`, { mode: 0o755 });
}

// スタブの切り替え: running（compose ps が api を返す）/ docker-down（info と up が失敗）/
// compose-fail / compose-hold（compose-release まで待つ）/ health-down（curl が1回失敗）/
// npm-fail / npm-hold（npm-release まで待つ）
function makeWorld() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-stack-'));
  const root = path.join(base, 'home');
  const bin = path.join(base, 'bin');
  const stubs = path.join(base, 'stubs');
  const state = path.join(base, 'state');
  fs.mkdirSync(root);
  fs.mkdirSync(bin);
  fs.mkdirSync(stubs);
  const log = path.join(base, 'calls');
  const ca = path.join(base, 'ca-bundle.crt');
  fs.writeFileSync(ca, '-----BEGIN CERTIFICATE-----\nDUMMY\n-----END CERTIFICATE-----\n');
  const hold = (flag, release) =>
    `if [ -f "${stubs}/${flag}" ]; then for _ in $(seq 1 200); do [ -f "${stubs}/${release}" ] && break; sleep 0.05; done; fi\n`;
  stub(
    bin,
    'docker',
    `echo "docker $*" >> "${log}"
case "$*" in
  info*) [ ! -f "${stubs}/docker-down" ] ;;
  *" ps "*) [ -f "${stubs}/running" ] && echo api; exit 0 ;;
  *" up --build"*)
    for f in $(find "${root}" -name .cloud-stack-ca.crt 2>/dev/null); do echo "ca-present $f" >> "${log}"; done
    ${hold('compose-hold', 'compose-release')}
    [ ! -f "${stubs}/docker-down" ] && [ ! -f "${stubs}/compose-fail" ] ;;
  *) exit 0 ;;
esac
`,
  );
  stub(bin, 'dockerd', `echo "dockerd" >> "${log}"\n( sleep 0.5; rm -f "${stubs}/docker-down" ) &\nexec sleep 6\n`);
  stub(bin, 'npm', `echo "npm $*" >> "${log}"\n${hold('npm-hold', 'npm-release')}[ ! -f "${stubs}/npm-fail" ]\n`);
  stub(bin, 'npx', `echo "npx $* (cwd=$(basename "$PWD"))" >> "${log}"\n`);
  stub(bin, 'curl', `echo "curl $*" >> "${log}"\nif [ -f "${stubs}/health-down" ]; then rm -f "${stubs}/health-down"; exit 7; fi\n`);
  return { base, root, bin, stubs, state, log, ca };
}

function run(world, args, { remote = 'true', ca = true, root } = {}) {
  const env = {
    ...process.env,
    PATH: `${world.bin}:${process.env.PATH}`,
    CLOUD_STACK_ROOT: root ?? world.root,
    CLOUD_STACK_STATE: world.state,
    CLOUD_CA_BUNDLE: ca ? world.ca : '/nonexistent/ca-bundle.crt',
    CLOUD_STACK_HEALTH_INTERVAL: '0',
    CLAUDE_CODE_REMOTE: remote,
  };
  return spawnSync('bash', [SCRIPT, ...args], { cwd: os.tmpdir(), encoding: 'utf8', env });
}

const calls = (w) => (fs.existsSync(w.log) ? fs.readFileSync(w.log, 'utf8').split('\n').filter(Boolean) : []);

async function waitFor(pred, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return pred();
}

function pidsMatching(needle) {
  const out = [];
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      if (fs.readFileSync(`/proc/${d}/cmdline`).toString().replace(/\0/g, ' ').includes(needle)) out.push(Number(d));
    } catch {}
  }
  return out;
}

function unlocked(lock) {
  if (!fs.existsSync(lock)) return true;
  return spawnSync('flock', ['-n', lock, 'true']).status === 0;
}

const st = (w, repo, name) => path.join(w.state, repo, name);

// ---- リポジトリの発見 ----

test('作業ディレクトリが親なら、直下の git リポジトリのうち manifest を持つものだけを見つける', () => {
  const w = makeWorld();
  makeRepo(w.root, 'alpha', manifest());
  makeRepo(w.root, 'beta', manifest());
  makeRepo(w.root, 'plain', null);
  fs.mkdirSync(path.join(w.root, 'not-git', '.claude'), { recursive: true });
  fs.writeFileSync(path.join(w.root, 'not-git', '.claude', 'cloud-stack.json'), '{}');
  const r = run(w, ['list']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split('\n').sort(), ['alpha', 'beta']);
});

test('作業ディレクトリ自体が git リポジトリなら、それ1つだけを対象にする', () => {
  const w = makeWorld();
  const repo = makeRepo(w.root, 'alpha', manifest());
  makeRepo(repo, 'nested', manifest());
  const r = run(w, ['list'], { root: repo });
  assert.equal(r.stdout.trim(), 'alpha');
});

// ---- prepare ----

test('prepare は準備コマンドを順に同期で実行し、npm と E2E ブラウザをバックグラウンドで始める', async () => {
  const w = makeWorld();
  const repo = makeRepo(w.root, 'alpha', manifest());
  const r = run(w, ['prepare']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(repo, '.prepared'), 'utf8'), 'prepared\nsecond\n', '準備コマンドが途中で飛んだ');
  assert.match(r.stdout, new RegExp(`alpha（${repo.replace(/[.]/g, '\\.')}）: 準備を開始: npm-web playwright-e2e。スタックは \`bash ${SCRIPT.replace(/[.]/g, '\\.')} up alpha --wait\``));
  assert.ok(await waitFor(() => fs.existsSync(st(w, 'alpha', 'npm-web.done')) && fs.existsSync(st(w, 'alpha', 'playwright-e2e.done'))));
  const c = calls(w);
  assert.ok(c.includes(`npm ci --prefix ${repo}/web`));
  assert.ok(c.includes('npx playwright install chromium chromium-headless-shell (cwd=e2e)'));
  assert.equal(c.filter((x) => x.includes('up --build')).length, 0, 'prepare でスタックを立ててはいけない');
});

test('prepare は完了済みの処理をやり直さない', async () => {
  const w = makeWorld();
  makeRepo(w.root, 'alpha', manifest());
  fs.mkdirSync(path.join(w.state, 'alpha'), { recursive: true });
  for (const t of ['npm-web', 'playwright-e2e']) fs.writeFileSync(st(w, 'alpha', `${t}.done`), '');
  const r = run(w, ['prepare']);
  assert.match(r.stdout, /alpha（.*）: 準備を開始: なし（完了済み）/);
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(calls(w).filter((x) => x.startsWith('npm ') || x.startsWith('npx ')).length, 0);
});

test('prepare は前回失敗した処理を知らせてやり直す', async () => {
  const w = makeWorld();
  makeRepo(w.root, 'alpha', manifest());
  fs.writeFileSync(path.join(w.stubs, 'npm-fail'), '');
  run(w, ['prepare']);
  assert.ok(await waitFor(() => fs.existsSync(st(w, 'alpha', 'npm-web.failed')) && unlocked(st(w, 'alpha', 'npm-web.lock'))));
  fs.rmSync(path.join(w.stubs, 'npm-fail'));
  const r = run(w, ['prepare']);
  assert.match(r.stdout, /alpha: 前回失敗した処理をやり直す: .*npm-web/);
  assert.ok(await waitFor(() => fs.existsSync(st(w, 'alpha', 'npm-web.done'))));
  assert.equal(fs.existsSync(st(w, 'alpha', 'npm-web.failed')), false);
});

test('進行中の npm は二重に起動しない', async () => {
  const w = makeWorld();
  const repo = makeRepo(w.root, 'alpha', manifest({ playwright: [] }));
  fs.writeFileSync(path.join(w.stubs, 'npm-hold'), '');
  run(w, ['prepare']);
  const line = `npm ci --prefix ${repo}/web`;
  assert.ok(await waitFor(() => calls(w).includes(line)));
  run(w, ['prepare']);
  await waitFor(() => calls(w).filter((x) => x === line).length >= 2, 1500);
  fs.writeFileSync(path.join(w.stubs, 'npm-release'), '');
  assert.ok(await waitFor(() => fs.existsSync(st(w, 'alpha', 'npm-web.done')) && unlocked(st(w, 'alpha', 'npm-web.lock'))));
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(calls(w).filter((x) => x === line).length, 1);
});

test('npm と E2E ブラウザが同じディレクトリなら、npm ci の完了を待ってからブラウザを入れる', async () => {
  const w = makeWorld();
  const repo = makeRepo(w.root, 'alpha', manifest({ npm: ['web'], playwright: ['web'] }));
  // npm ci は node_modules を先に作ってから中身を書く。ディレクトリの有無だけで判断すると途中の状態で npx が走る
  fs.mkdirSync(path.join(repo, 'web', 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(w.stubs, 'npm-hold'), '');
  run(w, ['prepare']);
  const line = `npm ci --prefix ${repo}/web`;
  assert.ok(await waitFor(() => calls(w).includes(line)));
  await new Promise((res) => setTimeout(res, 500));
  assert.equal(calls(w).filter((x) => x.startsWith('npx ')).length, 0, 'npm ci の途中でブラウザを入れ始めた');
  fs.writeFileSync(path.join(w.stubs, 'npm-release'), '');
  assert.ok(await waitFor(() => fs.existsSync(st(w, 'alpha', 'npm-web.done')) && fs.existsSync(st(w, 'alpha', 'playwright-web.done'))));
  const c = calls(w);
  assert.equal(c.filter((x) => x === line).length, 1, 'npm ci を二重に実行した');
  assert.ok(c.indexOf(line) < c.findIndex((x) => x.startsWith('npx ')));
});

test('npm の処理が失敗していたら、E2E ブラウザの処理が npm ci をやり直してから入れる', async () => {
  const w = makeWorld();
  const repo = makeRepo(w.root, 'alpha', manifest({ npm: ['web'], playwright: ['web'] }));
  fs.mkdirSync(path.join(w.state, 'alpha'), { recursive: true });
  fs.writeFileSync(st(w, 'alpha', 'npm-web.failed'), '');
  fs.mkdirSync(path.join(repo, 'web', 'node_modules'), { recursive: true });
  const r = run(w, ['--task', repo, 'playwright:web']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(st(w, 'alpha', 'playwright-web.done')));
  const c = calls(w);
  assert.ok(c.indexOf(`npm ci --prefix ${repo}/web`) >= 0 && c.indexOf(`npm ci --prefix ${repo}/web`) < c.findIndex((x) => x.startsWith('npx ')));
  assert.ok(fs.existsSync(st(w, 'alpha', 'npm-web.done')));
  assert.equal(fs.existsSync(st(w, 'alpha', 'npm-web.failed')), false);
});

// ---- up: CA 入りのクラウド用ビルド ----

function blocksAfterFrom(text) {
  const lines = text.split('\n');
  return lines.flatMap((l, i) => (/^FROM\s/.test(l) ? [lines.slice(i + 1, i + 7)] : []));
}

test('compose.env_file があれば --env-file を付けて起動する。無い／存在しなければ付けない', () => {
  const w = makeWorld();
  const repo = makeRepo(w.root, 'alpha', manifest({ compose: { ...manifest().compose, env_file: 'env.dev' } }));
  fs.writeFileSync(path.join(repo, 'env.dev'), 'SIG_KEY=x\n');
  run(w, ['up', 'alpha', '--wait']);
  assert.ok(calls(w).some((c) => c.includes(`--env-file ${repo}/env.dev`)), '--env-file が付いていない');
});

test('compose.env_file を書いても、ファイルが無ければ --env-file を付けない', () => {
  const w = makeWorld();
  const repo = makeRepo(w.root, 'alpha', manifest({ compose: { ...manifest().compose, env_file: 'env.dev' } }));
  run(w, ['up', 'alpha', '--wait']);
  assert.equal(calls(w).some((c) => c.includes('--env-file')), false, '無いファイルを --env-file に指定した');
});

test('up は元の Dockerfile のすべての FROM の直後に CA を入れたクラウド用を作り、元の行は残す', () => {
  const w = makeWorld();
  const repo = makeRepo(w.root, 'alpha', manifest());
  const r = run(w, ['up', 'alpha', '--wait']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const [i, src] of [
    [0, BACKEND_DOCKERFILE],
    [1, FRONTEND_DOCKERFILE],
  ]) {
    const gen = fs.readFileSync(st(w, 'alpha', `Dockerfile.cloud.${i}`), 'utf8');
    const blocks = blocksAfterFrom(gen);
    assert.equal(blocks.length, blocksAfterFrom(src).length);
    for (const b of blocks) {
      assert.equal(b[0], 'COPY .cloud-stack-ca.crt /etc/ccr-ca-bundle.crt');
      const env = b.slice(1).join(' ');
      for (const v of ['PIP_CERT', 'REQUESTS_CA_BUNDLE', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'GIT_SSL_CAINFO']) {
        assert.match(env, new RegExp(`${v}=/etc/ccr-ca-bundle\\.crt`));
      }
    }
    const it = gen.split('\n')[Symbol.iterator]();
    for (const line of src.split('\n')) {
      let found = false;
      for (const g of it) if (g === line) { found = true; break; }
      assert.ok(found, `元の行が落ちた: ${line}`);
    }
  }
  assert.ok(fs.existsSync(path.join(repo, 'Dockerfile')));
});

test('up は同じ Dockerfile を使う全サービスを差し替える上書きを付けて起動する', () => {
  const w = makeWorld();
  const repo = makeRepo(w.root, 'alpha', manifest());
  run(w, ['up', 'alpha', '--wait']);
  const override = fs.readFileSync(st(w, 'alpha', 'docker-compose.cloud.yml'), 'utf8');
  const service = (name) => override.split(/\n(?=  \S)/).find((b) => b.includes(`  ${name}:`)) ?? '';
  for (const [svc, i, ctx] of [
    ['api', 0, repo],
    ['worker', 0, repo],
    ['web', 1, path.join(repo, 'web')],
  ]) {
    assert.match(service(svc), new RegExp(`dockerfile: ${st(w, 'alpha', `Dockerfile.cloud.${i}`).replace(/[.]/g, '\\.')}`), svc);
    assert.match(service(svc), new RegExp(`context: ${ctx.replace(/[.]/g, '\\.')}\\n`), svc);
  }
  const up = calls(w).find((c) => c.includes(' up --build -d'));
  assert.equal(
    up,
    `docker compose --project-directory ${repo} -f ${repo}/compose.yml -f ${repo}/compose.ci.yml -f ${st(w, 'alpha', 'docker-compose.cloud.yml')} up --build -d`,
  );
});

test('up は pre_up → ビルド → health → post_up の順に進み、完了の目印を書く', () => {
  const w = makeWorld();
  const repo = makeRepo(w.root, 'alpha', manifest());
  run(w, ['up', 'alpha', '--wait']);
  assert.equal(fs.readFileSync(path.join(repo, '.hooks'), 'utf8'), 'pre\npost\n');
  const c = calls(w);
  const up = c.findIndex((x) => x.includes(' up --build -d'));
  const health = c.findIndex((x) => x.startsWith('curl ') && x.includes('http://localhost:9999/health'));
  assert.ok(up >= 0 && health > up);
  assert.ok(fs.existsSync(st(w, 'alpha', 'stack.done')));
});

test('ビルドの間だけ各コンテキストに CA を置き、成功後に消し、クローンの除外に足す', () => {
  const w = makeWorld();
  const repo = makeRepo(w.root, 'alpha', manifest());
  run(w, ['up', 'alpha', '--wait']);
  const present = calls(w).filter((c) => c.startsWith('ca-present ')).map((c) => c.slice(11)).sort();
  assert.deepEqual(present, [path.join(repo, '.cloud-stack-ca.crt'), path.join(repo, 'web', '.cloud-stack-ca.crt')]);
  assert.equal(fs.existsSync(path.join(repo, '.cloud-stack-ca.crt')), false);
  assert.equal(fs.existsSync(path.join(repo, 'web', '.cloud-stack-ca.crt')), false);
  // 消し損ねてもコミットされないこと。書いた文字列ではなく、git が実際に除外と判定するかで見る
  for (const f of ['.cloud-stack-ca.crt', 'web/.cloud-stack-ca.crt']) {
    fs.writeFileSync(path.join(repo, f), 'x');
    assert.equal(spawnSync('git', ['-C', repo, 'check-ignore', '-q', f]).status, 0, `除外されていない: ${f}`);
    fs.rmSync(path.join(repo, f));
  }
});

test('ca_builds の context が兄弟リポジトリなら、CA を置いた側の除外に足す', () => {
  const w = makeWorld();
  const repo = makeRepo(w.root, 'alpha', manifest({
    compose: {
      files: ['compose.yml'],
      ca_builds: [{ dockerfile: '../beta/Dockerfile', context: '../beta', services: ['sibling'] }],
      pre_up: [],
      post_up: [],
    },
  }));
  const sibling = makeRepo(w.root, 'beta', null);
  fs.writeFileSync(path.join(sibling, 'Dockerfile'), FRONTEND_DOCKERFILE);
  const r = run(w, ['up', 'alpha', '--wait']);
  assert.equal(r.status, 0, r.stderr);
  const caPath = path.join(sibling, '.cloud-stack-ca.crt');
  assert.equal(fs.existsSync(caPath), false, 'ビルド後に消えていない');
  // 消し損ねても、置いた実体（beta）の側で除外されること。alpha 側の除外は見ない
  fs.writeFileSync(caPath, 'x');
  assert.equal(spawnSync('git', ['-C', sibling, 'check-ignore', '-q', '.cloud-stack-ca.crt']).status, 0, 'beta 自身の除外に入っていない');
  fs.rmSync(caPath);
});

test('ビルドに失敗したら health を待たずに失敗の目印を書き、CA を残さない', () => {
  const w = makeWorld();
  const repo = makeRepo(w.root, 'alpha', manifest());
  fs.writeFileSync(path.join(w.stubs, 'compose-fail'), '');
  const r = run(w, ['up', 'alpha', '--wait']);
  assert.equal(r.status, 1);
  assert.ok(fs.existsSync(st(w, 'alpha', 'stack.failed')));
  assert.equal(calls(w).filter((c) => c.startsWith('curl ')).length, 0);
  assert.equal(fs.existsSync(path.join(repo, '.cloud-stack-ca.crt')), false);
});

test('CA が無ければクラウド用を作らず、上書きを付けずに起動する', () => {
  const w = makeWorld();
  makeRepo(w.root, 'alpha', manifest());
  run(w, ['up', 'alpha', '--wait'], { ca: false });
  assert.equal(fs.existsSync(st(w, 'alpha', 'docker-compose.cloud.yml')), false);
  const up = calls(w).find((c) => c.includes(' up --build -d'));
  assert.ok(up && !up.includes('docker-compose.cloud.yml'));
});

test('health が失敗したら、上書きを付けて restart_service を起こし直す', () => {
  const w = makeWorld();
  const repo = makeRepo(w.root, 'alpha', manifest());
  fs.writeFileSync(path.join(w.stubs, 'health-down'), '');
  run(w, ['up', 'alpha', '--wait']);
  const restarts = calls(w).filter((c) => c.endsWith(' up -d api'));
  assert.ok(restarts.length >= 1);
  assert.ok(restarts.every((c) => c.includes(`-f ${st(w, 'alpha', 'docker-compose.cloud.yml')}`)));
  assert.ok(fs.existsSync(st(w, 'alpha', 'stack.done')));
});

test('dockerd が止まっていれば起動を待ってからビルドし、dockerd がロックを握り続けない', async () => {
  const w = makeWorld();
  makeRepo(w.root, 'alpha', manifest());
  fs.writeFileSync(path.join(w.stubs, 'docker-down'), '');
  run(w, ['up', 'alpha', '--wait']);
  const c = calls(w);
  assert.ok(c.indexOf('dockerd') >= 0 && c.indexOf('dockerd') < c.findIndex((x) => x.includes(' up --build -d')));
  assert.ok(await waitFor(() => unlocked(st(w, 'alpha', 'stack.lock')), 3000), 'dockerd がロックを握っている');
});

test('起動済み（目印あり・サービス稼働中）なら up は何もしない。止まっていれば立て直す', () => {
  const w = makeWorld();
  makeRepo(w.root, 'alpha', manifest());
  fs.mkdirSync(path.join(w.state, 'alpha'), { recursive: true });
  fs.writeFileSync(st(w, 'alpha', 'stack.done'), '');
  fs.writeFileSync(path.join(w.stubs, 'running'), '');
  assert.match(run(w, ['up', 'alpha', '--wait']).stdout, /alpha: 起動済み/);
  assert.equal(calls(w).filter((c) => c.includes('up --build')).length, 0);
  fs.rmSync(path.join(w.stubs, 'running'));
  run(w, ['up', 'alpha', '--wait']);
  assert.equal(calls(w).filter((c) => c.includes('up --build')).length, 1);
});

test('ビルド中に2本目の up が起動しても、1本目の CA を消さず、二重にビルドしない', async () => {
  const w = makeWorld();
  const repo = makeRepo(w.root, 'alpha', manifest());
  fs.writeFileSync(path.join(w.stubs, 'compose-hold'), '');
  run(w, ['up', 'alpha']);
  assert.ok(await waitFor(() => calls(w).some((c) => c.startsWith('ca-present '))));
  run(w, ['up', 'alpha']);
  await new Promise((res) => setTimeout(res, 800));
  assert.ok(fs.existsSync(path.join(repo, '.cloud-stack-ca.crt')), '2本目が CA を消した');
  fs.writeFileSync(path.join(w.stubs, 'compose-release'), '');
  assert.ok(await waitFor(() => fs.existsSync(st(w, 'alpha', 'stack.done')) && unlocked(st(w, 'alpha', 'stack.lock'))));
  assert.equal(calls(w).filter((c) => c.includes(' up --build -d')).length, 1);
});

test('中断されても CA を残さない', async () => {
  const w = makeWorld();
  const repo = makeRepo(w.root, 'alpha', manifest());
  fs.writeFileSync(path.join(w.stubs, 'compose-hold'), '');
  run(w, ['up', 'alpha']);
  assert.ok(await waitFor(() => calls(w).some((c) => c.startsWith('ca-present '))));
  const pids = pidsMatching(`${SCRIPT} --task ${repo} stack`);
  assert.ok(pids.length > 0);
  for (const pid of pids) process.kill(pid, 'SIGTERM');
  fs.writeFileSync(path.join(w.stubs, 'compose-release'), '');
  assert.ok(await waitFor(() => !fs.existsSync(path.join(repo, '.cloud-stack-ca.crt')), 5000));
});

// ---- status / test ----

test('status は処理ごとに done / failed / running を出す', () => {
  const w = makeWorld();
  makeRepo(w.root, 'alpha', manifest());
  const d = path.join(w.state, 'alpha');
  fs.mkdirSync(d, { recursive: true });
  for (const [t, s] of [['stack', 'done'], ['npm-web', 'failed'], ['playwright-e2e', null]]) {
    fs.writeFileSync(path.join(d, `${t}.log`), '');
    if (s) fs.writeFileSync(path.join(d, `${t}.${s}`), '');
  }
  assert.equal(run(w, ['status', 'alpha']).stdout.trim(), 'alpha: npm-web=failed playwright-e2e=running stack=done');
});

test('test は名前を指定するとそのコマンドだけ、省略すると全部をリポジトリで実行する', () => {
  const w = makeWorld();
  const repo = makeRepo(w.root, 'alpha', manifest());
  assert.equal(run(w, ['test', 'alpha', 'unit']).status, 0);
  assert.equal(fs.readFileSync(path.join(repo, '.tests'), 'utf8'), 'unit-ran\n');
  fs.rmSync(path.join(repo, '.tests'));
  assert.equal(run(w, ['test', 'alpha']).status, 0);
  assert.equal(fs.readFileSync(path.join(repo, '.tests'), 'utf8'), 'e2e-ran\nunit-ran\n');
  const missing = run(w, ['test', 'alpha', 'nope']);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /ある名前: e2e, unit/);
});

test('見つからないリポジトリを指定すると止まる', () => {
  const w = makeWorld();
  makeRepo(w.root, 'alpha', manifest());
  const r = run(w, ['up', 'ghost']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /リポジトリが見つからない/);
});

// ---- SessionStart hook ----

function runHook(w, remote) {
  const env = {
    ...process.env,
    PATH: `${w.bin}:${process.env.PATH}`,
    CLAUDE_PROJECT_DIR: w.root,
    CLOUD_STACK_STATE: w.state,
    CLOUD_CA_BUNDLE: w.ca,
    CLAUDE_CODE_REMOTE: remote,
  };
  return spawnSync('bash', [HOOK], { cwd: os.tmpdir(), encoding: 'utf8', env });
}

test('SessionStart hook はローカルでは何もしない', () => {
  const w = makeWorld();
  const repo = makeRepo(w.root, 'alpha', manifest());
  const r = runHook(w, '');
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(fs.existsSync(path.join(repo, '.prepared')), false);
  assert.equal(fs.existsSync(w.state), false);
});

test('SessionStart hook はクラウドでは CLAUDE_PROJECT_DIR の下のリポジトリを準備する', async () => {
  const w = makeWorld();
  const repo = makeRepo(w.root, 'alpha', manifest());
  const r = runHook(w, 'true');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /alpha（.*）: 準備を開始/);
  assert.ok(fs.existsSync(path.join(repo, '.prepared')));
  await waitFor(() => fs.existsSync(st(w, 'alpha', 'npm-web.done')));
});

test('SessionStart hook は準備が失敗してもセッション開始を止めない', () => {
  const w = makeWorld();
  makeRepo(w.root, 'alpha', manifest({ prepare: ['exit 3'] }));
  const r = runHook(w, 'true');
  assert.equal(r.status, 0);
});

test('dev-flow の hooks.json が SessionStart でこの hook を呼ぶ', () => {
  const hooksJson = path.join(path.dirname(HOOK), 'hooks.json');
  const entries = JSON.parse(fs.readFileSync(hooksJson, 'utf8')).hooks.SessionStart ?? [];
  const cmds = entries.flatMap((e) => (e.hooks ?? []).map((h) => ({ ...h, matcher: e.matcher })));
  const mine = cmds.filter((h) => h.command === 'bash "${CLAUDE_PLUGIN_ROOT}/hooks/cloud-session-start.sh"');
  assert.equal(mine.length, 1);
  // resume でも準備をやり直す（VM が作り直されると依存も消える）
  assert.match(mine[0].matcher, /startup/);
  assert.match(mine[0].matcher, /resume/);
});
