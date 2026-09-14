---
name: dev-verify
description: 検証フェーズ。実装完了後（Phase単位）の動作確認、E2Eテスト作成・追加・実行、セキュリティ検証、UI改善を行う。新規Phase直後だけでなく、**既存テストの不安定化対応（flaky / skipped の安定化）、追加E2Eシナリオ作成、ローカル／本番URLでの動作確認依頼、参照基準を伴うテスト整備（例:「監督者の定期面談レベルで」）** にも使う。ユーザーが「動作確認したい」「ローカル環境で確認したい」「URLを教えて」「E2Eテストを作って」「E2Eテストを追加して」「○○レベルでE2E用意して」「flakyを安定させたい」「skippedを直したい」「テストを安定させて」「ローカルで挙動を見たい」と言ったら起動する。
user-invocable: true
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, Agent, mcp__chrome-devtools__*, mcp__playwright__*, gh
---

# /dev-verify - 検証フェーズ

## リファレンス

- **セキュリティチェックリスト**: [reference/security-checklist.md](reference/security-checklist.md)（D4.5 で security-tester に渡す）
- **引継書テンプレート**: [../_shared/reference/handover-template.md](../_shared/reference/handover-template.md)
- **QC overlay 契約**: [../_shared/reference/qc-overlay.md](../_shared/reference/qc-overlay.md)（組織固有の QC 観点の差し込み方。観点そのものは dev-flow に同梱しない）

## 組織固有の QC 観点（overlay）

dev-flow は組織固有の品質観点を同梱しない。フェーズの開始時に overlay の適用状況を判定する。

```bash
bash <skill-dir>/../_shared/scripts/qc-overlay.sh --phase verify
```

- `overlay_applied` が `1` → `file` のパスを Read し、並んでいる観点をこのフェーズの追加レンズとして適用する
- `overlay_applied` が `0` → 観点を**自作せずスキップする**（組織の QC を dev-flow が発明してはいけない）

どちらの場合も **適用したかスキップしたかを1行報告する。黙って素通りしない。** `warnings` があれば添える。
判定が `overlay_present` ではなく `overlay_applied` を見ている理由を含む契約は
[../_shared/reference/qc-overlay.md](../_shared/reference/qc-overlay.md)。

クロスブラウザ・性能・負荷の具体的な閾値は組織ごとに違うため overlay 側に置く。
overlay が無い環境では、セキュリティ検証（D4.5）と E2E だけがこのフェーズの担保になることを報告する。

## エージェント構成

| エージェント | 役割 | 起動タイミング |
|---|---|---|
| e2e-test-generator | E2E テストコード生成 | D3 |
| security-tester | セキュリティ観点の実機検証 | D4.5（**e2e-test-generator と並列起動可**） |

> **並列実行ルール**: e2e-test-generator は「コード生成中心」、security-tester は「実機ブラウザ操作中心」で観点が独立しているため並列起動を許容する。ただし Playwright MCP のブラウザは1セッションのため、ブラウザ操作のタイミングは security-tester に優先権を与え、e2e-test-generator のローカル試走と被らないよう順番を制御する。

## 手順

### D0. 引継書の読み込み
1. `bash skills/_shared/scripts/latest-handover.sh` で最新引継書のパスを取得
2. 実装済みファイル一覧、環境情報、ユーザー指示を確認

### D1. ローカル環境での動作確認
1. chrome-devtools MCP でブラウザを操作
2. ログイン → 対象画面へ遷移 → 主要操作を実行
3. コンソールエラー・ネットワークエラーを確認
4. スクリーンショットで画面状態を記録

### D2. テストデータの準備

**テストデータがないことを理由にテストをスキップしてはならない。**

1. テストに必要なマスターデータを洗い出す（企業、担当者、ユーザー等）
2. テストデータ作成ヘルパーの確認:
   - `e2e/tests/helpers/test-data.ts` が存在するか確認
   - なければ新規作成（API 経由でデータ作成・削除するユーティリティ）
3. テストデータは以下の方法で準備:
   - **E2E テスト内**: beforeAll で API 経由作成 → afterAll で削除（推奨）
   - **手動確認時**: chrome-devtools or curl で API 経由作成
   - **DB 直接操作は最終手段**: API が使えない場合のみ

### D3. E2E テスト作成（e2e-test-generator）
1. **`dev-flow:e2e-test-generator` エージェント**を起動
2. **セキュリティテストは常に生成する** → `e2e/tests/security/<機能名>-security.spec.ts`
3. **ユーザーストーリーテスト・機能テストは既定では生成しない。** 次のいずれかに当たるときだけ
   生成し、**理由を spec 冒頭のコメントに明記させる**:
   1. コア導線そのものを変更する場合（ログイン・決済・申請の承認/却下・権限やテナント境界をまたぐ操作）
   2. pytest / vitest では原理的に検証できない場合（複数画面をまたぐ状態遷移・ブラウザ固有の挙動）
   - **どちらの条件にも自信が持てないときは `skills/_shared/reference/core-flow.md` を読む**（非該当例と「迷ったら生成する側に倒す」はそこにしか無い）
4. 出力先（3 に該当した場合）:
   - `e2e/tests/user-stories/<機能名>.spec.ts`
   - `e2e/tests/functional/<機能名>-functional.spec.ts`
5. **各テストに beforeAll/afterAll でテストデータの作成・削除を含める**
6. **どのカテゴリを生成したかを控える**（D4 の実行対象がこれで決まる）

> **セキュリティテストは「生成」と「実機検証」で担当が分かれる。** spec の生成は本 D3 の **e2e-test-generator**（Step 8 → `e2e/tests/security/<機能名>-security.spec.ts`）が行い、D4.5 の **security-tester** は生成された spec を含めた**実機検証**を担当する（security-tester 側に spec の生成手順は無い）。**問題2 で user-stories / functional を条件付きにしても Step 8 は据え置く**（消すと security spec の生成経路が dev-flow 全体から消滅する）。

### D4. E2E テスト実行
```bash
npm run test:e2e                 # 全テスト
npm run test:e2e:user-stories    # ユーザーストーリーのみ（D3-3 で生成した場合のみ）
npm run test:e2e:functional      # 機能テストのみ（D3-3 で生成した場合のみ）
```

- **`test:e2e:core` は既存カテゴリの部分集合**であり、4本目の独立したカテゴリではない。
  上の `test:e2e` / `test:e2e:user-stories` / `test:e2e:functional` から ship 前に必ず
  緑を確認したい spec だけを束ねたショートカットで、`dev-ship` E1.2 が ship のたびに実行する
  （定義手順は次の節）。

> ⚠ **D3 で生成しなかったカテゴリのスクリプトは実行しない。** Playwright は spec が0本のとき
> `Error: No tests found` を出して **exit 1** を返す（1.49.1 で実測）。生成していないカテゴリを
> 実行すると「E2E が落ちている」ように見え、存在しないテストを D5 で直そうとすることになる。
> どうしても一括で回したい場合はカテゴリ別スクリプトにだけ `--pass-with-no-tests` を付ける。
>
> **`npm run test:e2e` 本体には付けないこと。** security spec は常に生成される契約なので、
> 全体が0本というのは「生成器が何も作らなかった」状態であり、そこは exit 1 のままにして
> 検知させる必要がある。

**全テストが PASS するまで次に進まない。** 失敗があれば D5 で修正してから D4 を再実行する（Feedback loop）。

**スクリーンショット・動画の確認**:
1. `playwright.config.ts` に `viewport: { width: 1920, height: 1080 }`（フルHD、ユーザーの実環境に一致）と `screenshot: 'on'` と `video: 'on'` が設定されていることを確認（成功・失敗に関わらず全テストで自動撮影・録画。なければ追加する）
2. スクリーンショット・動画（`video.webm`）は `e2e/test-results/<テスト名>/` に自動保存される
3. `npx playwright show-report e2e/playwright-report` でテストごとの画面・動画を確認（動画レビューは再生速度 0.5x が見やすい）
4. spec ファイルが `test`/`expect` を `e2e/tests/helpers/fixtures.ts` から import していることを確認（ローカル実行時のみ録画用カーソルが全テストに自動注入される）
5. `e2e/test-results/`・`e2e/playwright-report/` は実行ごとに再生成されるため `.gitignore` に登録されていることを確認

### D4.5. セキュリティ検証（security-tester）⚠ 必須（スキップ不可）

**機能が動くことと、安全に動くことは別問題。** `dev-flow:security-tester` エージェントを起動して [reference/security-checklist.md](reference/security-checklist.md) の全観点を検証する。

1. **`dev-flow:security-tester` エージェント**を起動。入力:
   - Issue 番号 / ブランチ名
   - 起動 URL とログイン情報
   - チェックリストのパス: `skills/dev-verify/reference/security-checklist.md`
   - 出力先: `.agent/reports/security-check-<Issue番号>.md`
2. **並列起動の可否**: D3 の e2e-test-generator がコード生成段階（ブラウザ操作なし）であれば、security-tester を**同時起動してよい**。ブラウザ操作のタイミングは security-tester 優先
3. 検証完了後、security-tester が出力した `.agent/reports/security-check-<Issue番号>.md` を読み、Critical / Major 件数を引継書に転記
4. **Critical があれば D5 で必ず修正** → 修正後に security-tester を再起動して再検証

### D4.6. `test:e2e:core` の定義（dev-ship E1.2 が実行するコア E2E を作る唯一の producer）

`dev-ship` E1.2 は `package.json` の `test:e2e:core` が定義されていれば実行するが、
**それを定義するのはこの手順だけ**。これが無かったときの実測:
ホーム配下で `test:e2e:core` を定義した `package.json` は **0件**で、「E2E の生成を減らした分、
残したものは必ず回す」という E1.2 の担保が発火する対象そのものが無い状態だった。

> `<REPO_ROOT>` は対象リポジトリルートの絶対パス（`git -C <dir> rev-parse --show-toplevel` の値）。
> `dev-ship` E0.5・E0.7・E1.2 と同じ規約に揃える（Bash の cwd はターン間で launch dir に戻るため、
> cwd 相対で書くと monorepo や worktree で無音のズレを起こす）。

- **発火条件**（次のいずれかに当たったら実施する。どちらでもなければ no-op）:
  1. `package.json` に `test:e2e:core` が**未定義**
  2. 定義済みでも、**この Phase でコア導線そのものを変更した**（D3-3 の条件(1) に当たった）なら**中身を見直す**

  ```bash
  if [ ! -f <REPO_ROOT>/package.json ]; then
    echo "package.json が無いため no-op"
  elif node -e "process.exit(require('<REPO_ROOT>/package.json').scripts?.['test:e2e:core'] ? 0 : 1)" 2>/dev/null; then
    echo "定義済み（コア導線を変更した Phase でなければ no-op）"
  else
    echo "未定義"
  fi
  ```

- **`package.json` が無ければ no-op**（npm プロジェクトでないリポジトリに `test:e2e:core` の概念は無い）。
  Python / Go / Ansible リポはこの `[ ! -f ]` で落ちるので node 行には到達しない
- **`2>/dev/null` は分岐ではなく stderr を消している。** 壊れた `package.json` では `require()` が
  例外を投げるが、**分岐は「未定義」側で変わらない**（外しても同じ側に落ちる）。消しているのは
  SyntaxError のスタックトレースで、これが出ると probe 自体が壊れたように見えて no-op 判定を誤読する

対話手順:

1. **副作用の確認を対話より先に行う**（ここを飛ばして定義だけ進めると、`dev-setup` B3 と
   同じ事故を producer 自身が再生産する）:
   - **DB を触るか**: この E2E が DB を読み書きするなら、`dev-ship` E1.2 が ship のたびに実行する。並行 worktree と同じ DB を共有していないかを先に確認する
   - **`COMPOSE_PROJECT_NAME` で隔離されているか**: 未設定だと空 volume が新規作成され、ローカル DB を失ったように見える（`dev-setup` B3 の実測事故）
   - **隔離されていなければ、定義を進める前にユーザーに確認する**（黙って走らせない）
2. **コア導線に該当する既存 spec を候補提示する**（該当例・非該当例・迷ったら該当側に倒す、は
   `core-flow.md` にしか無い）:
   - どの spec をコアに入れるかは `skills/_shared/reference/core-flow.md` の定義に照らして選ぶ
   - **候補が0本なら定義しない（no-op）。** 空の定義は Playwright が `No tests found` で exit 1 を返し、以後 ship のたびに E1.2 が赤くなる
3. **`AskUserQuestion` で「定義する / 定義しない（既定のままで妥当）」を確認する**。
   「定義しない」も正しい選択肢だが、選んだ場合は次の無音化が起きることを先に伝える:

   > ⚠ **「定義しない」を選ぶと、E1.2 は永久に「未定義のためスキップ」を出し続ける。**

   - **判断と理由は D7 の引継書に必ず記録する**（記録が無いと、次の Phase の verify で同じ対話が再発する）
4. **既存の `scripts` に1行足す**（**`package.json` の骨格ごと上書きしない**。`dependencies` など他の設定が消える）。
   候補パスを列挙する形で書く（info string は `json`。**この実例をそのままコピーしないこと**——
   対象 spec はリポジトリごとに違うため、2 で選んだ候補パスに差し替える）:
   ```json
   {
     "scripts": {
       "test:e2e:core": "playwright test e2e/tests/security e2e/tests/user-stories/login.spec.ts"
     }
   }
   ```
   - **`test:e2e:core` は既存カテゴリの部分集合**であり、4本目の独立したカテゴリではない
5. **実際に1回実行して緑であることを確認する**（`npm --prefix <REPO_ROOT> run test:e2e:core`。
   cwd 非依存で書く。消費側 E1.2 と同じ理由）:
   - **赤いときは D5 でコードを直す。落ちている spec を `test:e2e:core` から外して緑にしないこと**（producer 側から E1.2 を構造的に緑にできてしまう）
6. **緑を確認してからコミットする**:
   - **緑を確認してから `git -C <REPO_ROOT> add package.json` して単独コミットする**（commit されていないと、定義したつもりで E1.2 は永久に「未定義のためスキップ」を出し続ける）

### D5. バグ修正
1. D4 / D4.5 で発見したバグ・脆弱性を修正
2. 修正ごとにコミット: `fix: <内容> #<Issue番号>`
3. **回帰確認**: D4 のテスト再実行、Critical を直したら security-tester も再起動
4. 全テスト PASS かつ Critical 0 件になるまで D4 / D4.5 / D4.6 / D5 のループを繰り返す

### D6. UI 改善（ユーザーフィードバック）
1. ユーザーからのフィードバックを収集
2. Issue 本文の画面仕様と照合して差異を確認
3. 修正・コミット

### D6.5. 変更理解ドキュメント生成（explain-diff）— 全 Phase 完了時のみ

**全 Phase の実装・検証が完了した場合のみ実施**（未実装 Phase が残っていればスキップ）。ship 前の人間レビューは「/dev-ship と言う前」に行われるため、**レビュー材料はこの時点で揃えておく**（dev-ship E2.5 で生成すると PR 作成後になり遅い）。

1. `/explain-diff` スキルを起動（対象: ブランチ全体 = `git diff origin/main..HEAD`）
2. 生成された HTML のパスをユーザーに提示し、「レビュー前にブラウザで開き、クイズで理解を確認するのを推奨」と添える
3. **実行マニフェスト**に追記: `node skills/_shared/scripts/hub-run-add.mjs --repo <repoルート> --run issue-<Issue番号> --flow dev-verify --issue <Issue番号> <explain-diff HTML のパス>`
4. 生成に失敗してもフェーズを止めない（D7 で手動 `/explain-diff` を案内）

### D7. 引継書更新 ⚠ 必須（スキップ不可）

> **注意**: このステップは verify フェーズの最終ステップであり、**ユーザーとのやり取りが途中で入っても必ず実行すること**。

1. `bash skills/_shared/scripts/new-handover-path.sh <Issue番号>` で新規引継書パスを発番
2. [../_shared/reference/handover-template.md](../_shared/reference/handover-template.md) の骨格 + verify 固有セクションを書き出す:
   - テスト結果サマリー（PASS/FAIL 件数）
   - セキュリティチェックサマリー（`security-check-<Issue番号>.md` のパスと Critical/Major 件数）
   - 残すべき主要画面のスクリーンショット・レビュー用動画（`e2e/test-results/` から `.agent/evidence/<Issue番号>/` にコピーし、パスで参照。次回のテスト実行で消えるため必ずコピー）
   - 未修正バグ一覧
   - ユーザーフィードバックで未対応のもの
3. コンテキストの区切りを判定する（[advisor の扱いとコンテキストの区切り](../_shared/reference/advisor-policy.md)。文言はそのまま）。次の 4 の確認はこの結果に従う:

   <!-- advisor-policy:context-check -->
   - 引継書を書いたら `node skills/_shared/scripts/context-size.mjs` でコンテキスト量を測る。`over` が `true` なら、次に進むかを尋ねる代わりに、測った `tokens` の値を示して「`/clear` してから次のコマンドを打ってください」と伝える。`tokens` が `null` なら `warning` をそのまま示し、従来どおり尋ねる
   <!-- /advisor-policy:context-check -->

4. 次のアクションをユーザーに確認:
   - **未実装 Phase が残っている場合**: 「Phase N の検証が完了しました。/clear して次 Phase（Phase N+1）の実装（/dev-implement）に進めますか？」
   - **全 Phase の実装・検証が完了した場合**（正準順は verify → test-spec → qa → 台帳 → ship）:
     - テスト仕様書が必要な案件 → 「全 Phase の実装・検証が完了しました。/clear してテスト仕様書フェーズ（/dev-test-spec）に進めますか？」
     - 小規模でテスト仕様書が不要な案件 → 「全 Phase の実装・検証が完了しました。/clear して QA フェーズ（/dev-qa）に進めますか？」（test-spec スキップ）
     - いずれも D6.5 の explain-diff HTML のパスを添える

### D7.5. 実行マニフェスト登録（推奨・スキップ可）

dev-hub の実行履歴ビューで verify 成果物を1セクションに束ねるため、`hub-run-add.mjs` で
E2E 動画・スクショ・レポート類を明示登録する。**動画（.webm/.mp4）はマニフェスト
経由でのみ dev-hub に表示される**ため、動画レビューを想定する場合は必須。

```bash
node skills/_shared/scripts/hub-run-add.mjs \
  --repo <repoルート> \
  --run issue-<Issue番号> \
  --flow dev-verify \
  --issue <Issue番号> \
  --label "<機能名>" \
  .agent/reports/security-check-<Issue番号>.md \
  .agent/evidence/<Issue番号>/videos/*.webm \
  .agent/evidence/<Issue番号>/screenshots/*.png
```

存在しないファイルは自動スキップ。D6.5 で登録済みの explain-diff HTML と同じ run-id
なので束ねられる。

> 途中 Phase での verify 実行時は本ステップをスキップしてよい（全 Phase 完了時の
> 最終 verify で1度だけ実施すれば十分）。hub-run-add は idempotent なので複数回呼んでも安全。

## chrome-devtools による動作確認パターン

```
1. navigate_page → ログイン画面
2. fill → メールアドレス・パスワード入力
3. click → ログインボタン
4. wait_for → ダッシュボード表示確認
5. click → 対象メニュー
6. wait_for → 対象画面表示確認
7. take_screenshot → 状態記録
8. 追加 → フォーム入力 → 保存 → 一覧確認
```
