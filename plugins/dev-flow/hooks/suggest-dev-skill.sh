#!/bin/bash
# dev-flow スキルサジェストフック
# UserPromptSubmit で発火し、ユーザー発話が dev-flow のトリガーワードに一致したら
# 「該当スキルの起動を検討せよ」というリマインダーをコンテキストに注入する。
# description 頼みの自動起動（モデルの注意力次第）を機械的な検知で補強する二段構えの後段。
# 判断はモデルに委ねるため、常に exit 0（発話をブロックしない）。
INPUT=$(cat)
PROMPT=$(echo "$INPUT" | jq -r '.prompt // empty')

# 空プロンプトは対象外
if [ -z "$PROMPT" ]; then
  exit 0
fi

# "/" 始まりは明示コマンドなのでサジェスト不要
if [[ "$PROMPT" == /* ]]; then
  exit 0
fi

# スキル名とトリガーパターンの対応表（判定は上から順、一致したものを全部列挙）
SKILLS=(
  "dev-plan|改修したい|企画|Issue.?切|仕様.*整理|現状を教えて|EOL|バージョンアップ"
  "dev-setup|ローカル環境|シードデータ|Docker化|環境.*作り直|ブランチ.*切"
  "dev-implement|実装し|着手|続きを|進めて|Phase|フェーズ"
  "dev-verify|動作確認|E2Eテスト|flaky|テスト.*安定"
  "dev-test-spec|テスト仕様書|手動テスト"
  "dev-fix|修正して|直して|バグ|動かない|おかしい|コンフリクト"
  "dev-qa|QAして|QAを"
  "dev-ship|PRを?(作|出)|マージして|リリース|ship"
  "dev-loop|ループで回|自動で回|往復させ"
  "dev|どういう状態|未リリース|続きをしたい"
)

MATCHED=()
for entry in "${SKILLS[@]}"; do
  name="${entry%%|*}"
  pattern="${entry#*|}"
  if echo "$PROMPT" | grep -qE "$pattern"; then
    MATCHED+=("/$name")
  fi
done

if [ ${#MATCHED[@]} -eq 0 ]; then
  exit 0
fi

LIST=$(IFS=' ' ; echo "${MATCHED[*]}")
echo "[dev-flow] この発話は ${LIST} のトリガーに一致します。開発作業の依頼であれば Skill ツールで該当スキルを起動してください（該当しなければ無視してよい）。"
exit 0
