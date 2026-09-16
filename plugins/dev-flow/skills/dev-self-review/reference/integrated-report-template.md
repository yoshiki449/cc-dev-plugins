# 統合レポートテンプレート（/dev-self-review S5 出力フォーマット）

`.agent/self-review/<Issue番号>/integrated-report.md` の標準フォーマット。**信頼度80以上**（しきい値はユーザー指定可）でフィルタされた指摘のみを掲載する。

## テンプレート

```markdown
# セルフレビュー統合レポート - Issue #<番号>
実行日: YYYY-MM-DD HH:MM / ブランチ: <名> / 差分: main...HEAD
信頼度しきい値: 80 / 並列エージェント: 5（判定 M × LOW）

## 総合判定: 合格 | 条件付き合格 | 不合格

| 観点 | 担当 | 状況 | Critical | Major | Minor |
|---|---|---|---|---|---|
| 規約 | convention-reviewer | ✅ | 0 | 1 | 3 |
| 要件達成度 | requirement-coverage-checker | ✅ | 0 | 1 | 0 |
| 簡潔化 | simplify-reviewer | ✅ | 0 | 0 | 5 |
| コード品質 | Code-Reviewer | ✅ / ⏭ S のため未起動 | 0 | 2 | 4 |
| 別モデル視点 | codex-cross-reviewer | ✅ / ⏭ 未接続 / ⏭ S のため未起動 | 1 | 1 | 2 |
| **合計（信頼度80+ / 重複統合後）** | - | - | **1** | **5** | **14** |

## 要件達成度サマリー
| 分類 | 完了 | テスト欠落 | 未着手 | 合計 |
|---|---|---|---|---|
| 機能要件 | 4 | 1 | 0 | 5 |
| 非機能要件 | 1 | 0 | 1 | 2 |
| エッジケース | 2 | 2 | 1 | 5 |
| **合計** | **7** | **3** | **2** | **12** |

達成率（実装＋テスト両方）: 7/12 = 58%

## 指摘一覧（信頼度80以上・重複統合済）

### Critical
| # | 信頼度 | 観点 | 指摘内容 | 対象 | 出典 | 推奨対応 |
|---|---|---|---|---|---|---|
| 1 | 95 [consensus] | 並行性 | 同時保存で last-write-wins | src/services/save.ts:67 | codex / Code-Reviewer | 楽観的ロック追加 |

### Major
| # | 信頼度 | 観点 | 指摘内容 | 対象 | 出典 | 推奨対応 |
|---|---|---|---|---|---|---|
| 2 | 95 | 命名 | useXxx hook が小文字始まり | src/hooks/MyHook.ts:1 | convention-reviewer | useMyHook にリネーム |
| 3 | 92 | 重複 | formatDate と utils/date.ts:formatLocaleDate が同等 | src/helpers/format.ts:42 | simplify-reviewer | utils 側を import |
| 4 | 90 | テスト欠落 | F2: メール認証のテストなし | src/auth/email.ts | coverage-checker | tests/auth/email.spec.ts 追加 |

### Minor
| # | 信頼度 | 観点 | 指摘内容 | 対象 | 出典 | 推奨対応 |
|---|---|---|---|---|---|---|

## コンセンサス指摘（複数エージェントが同一箇所を指摘）
| # | 観点 | 出典数 | 合算信頼度 |
|---|---|---|---|
| 1 | src/services/save.ts:67 / 並行性 | 2 (codex + Code-Reviewer) | 95 |

## 参考所見（対応不要・今回のPRの合否には含めない）
差分と無関係な既存コードの問題として Code-Reviewer 等が報告した項目。信頼度フィルタ・コンセンサス統合の対象外で、修正は任意（気になれば別Issueで扱う）。

| # | 観点 | 指摘内容 | 対象 | 出典 |
|---|---|---|---|---|
| 1 | エラーハンドリング | catch節が空でエラーが握りつぶされている | src/legacy/import.ts:120 | Code-Reviewer |

## 各エージェントの実行状況
- convention-reviewer: 成功（実行時間 XXs / 検出 N件）
- requirement-coverage-checker: 成功
- simplify-reviewer: 成功（`/simplify` 呼出済）
- Code-Reviewer: 成功 / **⏭ サイズ S のため未起動（ship に集約）**
- codex-cross-reviewer: 成功 / **⏭ 未接続（Codex CLI 未認証）** / **⏭ サイズ S のため未起動**

## /dev-fix への引き継ぎ
1. [Critical] #1: 楽観的ロック追加（src/services/save.ts）
2. [Major] #2: useXxx hook リネーム
3. [Major] #3: 重複ユーティリティ統合
4. [Major] #4: メール認証テスト追加

実行例: `/dev-fix .agent/self-review/<Issue番号>/integrated-report.md の指摘 #1,#2,#4 を修正`

## 良かった点
- ディレクトリ構造は src/features/<name>/ パターンに準拠
- 早期 return パターンの適用が良好
- F1（ユーザー登録）は実装・テストとも完備

## 総合判定の基準

- **合格**: Critical 0件 かつ Major 0件
- **条件付き合格**: Major のみ（ユーザー判断で /dev-fix へ）
- **不合格**: Critical あり（必ず /dev-fix へ）

**参考所見は上記の件数に含めない。** 差分と無関係な既存コードの指摘なので、何件あっても合否判定を変えない。
```

## 起動本数の記載ルール（3〜5並列）

起動本数は `gates.self_review_members` で決まる（S = 3本 / M・L = 5本）。レポート側の扱い:

- ヘッダの `並列エージェント: N` には**実際に起動した本数と判定**を書く（例: `3（判定 S × LOW）`）
- 観点テーブルと「各エージェントの実行状況」からは、**未起動の行を消さない**。
  `⏭ サイズ S のため未起動` と明記して残す。行ごと消すと「そもそもその観点が存在しない」ように
  読め、軽い経路を通したことが後から監査できなくなる
- `⏭ 未接続`（Codex CLI 未認証＝環境の問題）と `⏭ サイズ S のため未起動`（判定どおりの正常動作）は
  **別物として書き分ける**

## 重複統合（コンセンサス検出）ルール

- 「同じファイル × 同じ行番号 ± 3行 × 観点が類似」を1件に統合
- 信頼度は `max + min(20, (件数-1) * 5)` で補正（100上限）
- `sources` 欄に統合された全エージェント名を列挙
- 1件にまとめた後でも、各エージェントの個別レポート（`.agent/self-review/<Issue番号>/<agent>.md`）は削除せず残す（再評価用）

## 信頼度しきい値のオプション

- 既定 80
- 起動時に `--threshold N` で変更可能
- レポート冒頭に「信頼度しきい値: N」を必ず記載
