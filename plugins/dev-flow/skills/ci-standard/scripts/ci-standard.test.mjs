// ci-standard スキルのテスト（node --test）。
//
// - validate_ci.py: 標準のテンプレートは通り、標準から外した設定はルール ID 付きで落ちること
// - notify-e2e.sh: ローカルの HTTP サーバーに実際に POST させ、送信内容と失敗時の終了コードを見る
// - templates/ci-standard.yml の通知 step が templates/notify-e2e.sh と同一であること
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = readFileSync(join(SKILL_DIR, 'templates/ci-standard.yml'), 'utf8');
const NOTIFY_SH = join(SKILL_DIR, 'templates/notify-e2e.sh');
const VALIDATOR = join(SKILL_DIR, 'scripts/validate_ci.py');
const SYNC = join(SKILL_DIR, 'scripts/sync_template.py');

const workDir = mkdtempSync(join(tmpdir(), 'ci-standard-'));
let seq = 0;

function validate(text) {
  const file = join(workDir, `ci-${seq++}.yml`);
  writeFileSync(file, text);
  const r = spawnSync('python3', [VALIDATOR, file], { encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

/** n 番目（0 始まり）の出現だけを置き換える。対象が無ければテスト自体が壊れているので失敗させる。 */
function replaceNth(text, from, to, n = 0) {
  let idx = -1;
  for (let i = 0; i <= n; i++) {
    idx = text.indexOf(from, idx + 1);
    assert.notEqual(idx, -1, `変異の対象が見つからない: ${JSON.stringify(from)} (n=${n})`);
  }
  return text.slice(0, idx) + to + text.slice(idx + from.length);
}

describe('validate_ci.py: 標準のテンプレート', () => {
  test('テンプレートは適合する（NG なし・終了コード 0）', () => {
    const r = validate(TEMPLATE);
    assert.equal(r.status, 0, r.out);
    assert.doesNotMatch(r.out, /\[NG\]/);
  });

  test('通知 step のスクリプトは templates/notify-e2e.sh と同一', () => {
    const r = spawnSync('python3', [SYNC, '--check'], { encoding: 'utf8' });
    assert.equal(r.status, 0, 'sync_template.py を実行してテンプレートを同期する');
  });
});

// 標準から外した設定は、該当するルール ID 付きで不適合になる。
const DOCS_LINE = '      - ".claude/**"\n';
const MUTATIONS = [
  ['R1', 'PR の paths-ignore から .claude/** を外す', (t) => replaceNth(t, DOCS_LINE, '', 0)],
  ['R1', 'push の paths-ignore から .claude/** を外す', (t) => replaceNth(t, DOCS_LINE, '', 1)],
  ['R1', 'push の paths-ignore から **/*.md を外す', (t) => replaceNth(t, '      - "**/*.md"\n', '', 1)],
  ['R1', 'コードのパス（src/**）まで ignore する', (t) => replaceNth(t, DOCS_LINE, `${DOCS_LINE}      - "src/**"\n`, 0)],
  ['R2', 'cancel-in-progress を常時 true にする', (t) => replaceNth(t, "cancel-in-progress: ${{ github.event_name == 'pull_request' }}", 'cancel-in-progress: true')],
  ['R2', 'group を ref 単位に戻す', (t) => replaceNth(t, 'group: ci-${{ github.event.pull_request.number || github.sha }}', 'group: ci-${{ github.ref }}')],
  ['R3', 'e2e の if を削除する', (t) => replaceNth(t, "    if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'\n    needs: [lint, unit-test]\n", '    needs: [lint, unit-test]\n')],
  ['R3', 'e2e が pull_request でも走る', (t) => replaceNth(t, "    if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'\n    needs: [lint, unit-test]\n", "    if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch' || github.event_name == 'pull_request'\n    needs: [lint, unit-test]\n")],
  ['R4', 'schedule を削除する', (t) => replaceNth(t, '  schedule:\n    # 毎週月曜 09:17 JST（cron は UTC）。正時を避けて起動の遅延を抑える。\n    # schedule はデフォルトブランチの ci.yml だけが対象。\n    - cron: "17 0 * * 1"\n', '')],
  ['R4', 'cron を毎日にする', (t) => replaceNth(t, 'cron: "17 0 * * 1"', 'cron: "17 0 * * *"')],
  ['R4', 'cron を毎時にする', (t) => replaceNth(t, 'cron: "17 0 * * 1"', 'cron: "17 * * * 1"')],
  ['R4', 'schedule を 2 本にする', (t) => replaceNth(t, '    - cron: "17 0 * * 1"\n', '    - cron: "17 0 * * 1"\n    - cron: "17 12 * * 4"\n')],
  ['R5', '通知 job の always() を外す', (t) => replaceNth(t, "if: always() && (github.event_name == 'schedule' || github.event_name == 'workflow_dispatch')", "if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'")],
  ['R5', '通知 job の needs から e2e を外す', (t) => replaceNth(t, 'needs: [lint, unit-test, e2e]', 'needs: [lint, unit-test]')],
  ['R5', '通知 job の needs から前段 job を外す', (t) => replaceNth(t, 'needs: [lint, unit-test, e2e]', 'needs: [e2e]')],
  ['R5', '通知 job の permissions を削除する', (t) => replaceNth(t, '    permissions: {}\n', '')],
  ['R5', 'Webhook URL を直書きする', (t) => replaceNth(t, 'WEBHOOK_URL: ${{ secrets.GOOGLE_CHAT_WEBHOOK_URL }}', 'WEBHOOK_URL: https://chat.googleapis.com/v1/spaces/X/messages?key=a&token=b')],
  ['R5', '通知スクリプトから --fail-with-body を外す', (t) => replaceNth(t, '--fail-with-body ', '')],
  ['R5', '通知スクリプトに式を直接埋め込む', (t) => replaceNth(t, '          e2e_result=$(', '          echo "${{ github.ref_name }}" >/dev/null\n          e2e_result=$(')],
  ['R5', '通知 job を削除する', (t) => t.slice(0, t.indexOf('  notify-e2e:'))],
  ['R6', 'e2e の timeout-minutes を削除する', (t) => replaceNth(t, '    timeout-minutes: 20\n', '')],
  ['R6', 'e2e の timeout-minutes を 360 にする', (t) => replaceNth(t, 'timeout-minutes: 20', 'timeout-minutes: 360')],
  ['R7', 'lint を schedule 限定にする', (t) => replaceNth(t, '    name: Lint\n    runs-on: ubuntu-22.04\n', "    name: Lint\n    runs-on: ubuntu-22.04\n    if: github.event_name == 'schedule'\n")],
  ['R8', 'e2e の needs を外す', (t) => replaceNth(t, '    needs: [lint, unit-test]\n', '')],
  ['R8', 'e2e job を削除する', (t) => {
    const start = t.indexOf('  e2e:');
    const end = t.indexOf('  notify-e2e:');
    return t.slice(0, start) + t.slice(end);
  }],
];

describe('validate_ci.py: 標準から外した設定は不適合になる', () => {
  for (const [rule, name, mutate] of MUTATIONS) {
    test(`${rule}: ${name}`, () => {
      const r = validate(mutate(TEMPLATE));
      assert.equal(r.status, 1, r.out);
      assert.match(r.out, new RegExp(`\\[NG\\]\\s+${rule}\\b`), r.out);
    });
  }
});

describe('validate_ci.py: 印と例外', () => {
  test('印（# ci-standard: v1）が無いと警告するが、ルール違反が無ければ適合', () => {
    const r = validate(replaceNth(TEMPLATE, '# ci-standard: v1\n', ''));
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /\[警告\]\s+R0\b/);
  });

  test('例外を宣言すると E2E 関連（R3〜R5, R7, R8）を免除する', () => {
    const noE2e = replaceNth(TEMPLATE, "    if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'\n    needs: [lint, unit-test]\n", '    needs: [lint, unit-test]\n');
    const withException = replaceNth(noE2e, '# ci-standard: v1\n', '# ci-standard: v1\n# ci-standard-exception: 本番へ自動デプロイされるため PR でも E2E を必須にする\n');
    const r = validate(withException);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /例外/);
  });

  test('例外でも R1（docs スキップ）・R2・R6 は免除されない', () => {
    const broken = replaceNth(TEMPLATE, 'timeout-minutes: 20', 'timeout-minutes: 360');
    const r = validate(replaceNth(broken, '# ci-standard: v1\n', '# ci-standard: v1\n# ci-standard-exception: 理由あり\n'));
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /\[NG\]\s+R6\b/);
  });

  test('R9: 例外の理由が空だと不適合', () => {
    const r = validate(replaceNth(TEMPLATE, '# ci-standard: v1\n', '# ci-standard: v1\n# ci-standard-exception:\n'));
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /\[NG\]\s+R9\b/);
  });

  test('ファイルが読めないときは終了コード 2', () => {
    const r = spawnSync('python3', [VALIDATOR, join(workDir, 'no-such-file.yml')], { encoding: 'utf8' });
    assert.equal(r.status, 2);
  });
});

// --- 通知スクリプト（実際に HTTP サーバーへ POST させる） -----------------------------

function startServer(status = 200) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      requests.push({ contentType: req.headers['content-type'], body: Buffer.concat(chunks).toString('utf8') });
      res.statusCode = status;
      res.end('{}');
    });
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, requests, url: `http://127.0.0.1:${server.address().port}/v1/spaces/X/messages?key=k&token=t` })));
}

const needsJson = (e2e, others = {}) =>
  JSON.stringify({ lint: { result: 'success' }, 'unit-test': { result: 'success' }, e2e: { result: e2e }, ...Object.fromEntries(Object.entries(others).map(([k, v]) => [k, { result: v }])) });

async function runNotify({ status = 200, webhook, ...overrides } = {}) {
  const s = await startServer(status);
  const env = {
    PATH: process.env.PATH,
    WEBHOOK_URL: webhook ?? s.url,
    NEEDS_JSON: needsJson('success'),
    REPO_NAME: 'owner/repo',
    EVENT_NAME: 'schedule',
    REF_NAME: 'main',
    SHA: '0123456789abcdef0123456789abcdef01234567',
    RUN_URL: 'https://github.com/owner/repo/actions/runs/1',
    ...overrides,
  };
  const result = await new Promise((done) => {
    const p = spawn('bash', ['-eo', 'pipefail', NOTIFY_SH], { env });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => done({ code, out }));
  });
  s.server.close();
  return { ...result, requests: s.requests };
}

const textOf = (r) => JSON.parse(r.requests[0].body).text;

describe('notify-e2e.sh', () => {
  for (const [e2e, label] of [['success', '成功'], ['failure', '失敗'], ['skipped', '未実行'], ['cancelled', 'キャンセル']]) {
    test(`E2E が ${e2e} のとき「${label}」を JSON で POST する`, async () => {
      const r = await runNotify({ NEEDS_JSON: needsJson(e2e) });
      assert.equal(r.code, 0, r.out);
      assert.equal(r.requests.length, 1);
      assert.match(r.requests[0].contentType, /^application\/json/);
      const text = textOf(r);
      assert.ok(text.includes(label), text);
      assert.ok(text.includes('owner/repo'), 'リポジトリ名が入る（複数リポジトリを 1 スペースに集約しても区別できる）');
      assert.ok(text.includes('https://github.com/owner/repo/actions/runs/1'), text);
      assert.ok(text.includes('0123456') && !text.includes('0123456789abcdef'), '短縮 SHA');
      assert.ok(text.includes('定期実行'), text);
    });
  }

  test('手動実行と表示する', async () => {
    const r = await runNotify({ EVENT_NAME: 'workflow_dispatch' });
    assert.equal(r.code, 0, r.out);
    assert.ok(textOf(r).includes('手動実行'));
  });

  test('前段の job 名と結果を needs から表示する（E2E は含めない）', async () => {
    const r = await runNotify({ NEEDS_JSON: needsJson('skipped', { 'unit-test': 'failure', typecheck: 'success' }) });
    assert.equal(r.code, 0, r.out);
    const text = textOf(r);
    assert.ok(text.includes('unit-test=failure') && text.includes('lint=success') && text.includes('typecheck=success'), text);
    assert.ok(!text.includes('e2e=skipped'), text);
  });

  test('ブランチ名の引用符・改行・シェル記号でも JSON が壊れず、そのまま届く', async () => {
    const ref = 'feat/"q"\n$(echo x)`y`\\';
    const r = await runNotify({ REF_NAME: ref });
    assert.equal(r.code, 0, r.out);
    assert.ok(textOf(r).includes(ref));
  });

  test('Secret 未設定は失敗し、送信しない', async () => {
    const r = await runNotify({ webhook: '' });
    assert.notEqual(r.code, 0);
    assert.match(r.out, /GOOGLE_CHAT_WEBHOOK_URL/);
    assert.equal(r.requests.length, 0);
  });

  for (const status of [403, 500]) {
    test(`Chat API が HTTP ${status} を返したら失敗する`, async () => {
      const r = await runNotify({ status });
      assert.notEqual(r.code, 0, `HTTP ${status} で終了コード 0 になっている（--fail-with-body が無い）`);
      assert.ok(r.requests.length >= 1);
    });
  }
});

// --- 他のファイルとの整合 -------------------------------------------------------------

describe('スキルの配置', () => {
  test('スキル本体と参照資料がある', () => {
    for (const f of ['SKILL.md', 'references/rationale.md', 'templates/ci-standard.yml', 'templates/notify-e2e.sh', 'scripts/validate_ci.py']) {
      assert.ok(existsSync(join(SKILL_DIR, f)), f);
    }
  });

  test('dev-setup から [[ci-standard]] を参照している', () => {
    const setup = readFileSync(join(SKILL_DIR, '../dev-setup/SKILL.md'), 'utf8');
    assert.match(setup, /\[\[ci-standard\]\]/);
  });

  test('公開リポジトリに置けない値（実在の Webhook URL・固有名）を含まない', () => {
    for (const f of ['SKILL.md', 'references/rationale.md', 'templates/ci-standard.yml', 'templates/notify-e2e.sh']) {
      const text = readFileSync(join(SKILL_DIR, f), 'utf8');
      assert.doesNotMatch(text, /chat\.googleapis\.com/, f);
      assert.doesNotMatch(text, /[?&](key|token)=/, f);
    }
  });
});
