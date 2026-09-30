# Secret 未設定を黙ってスキップすると、通知されないことに気づけない。
if [ -z "${WEBHOOK_URL:-}" ]; then
  echo "::error::Secret GOOGLE_CHAT_WEBHOOK_URL が未設定です（Settings > Secrets and variables > Actions で登録してください）"
  exit 1
fi
# 結果は needs の JSON から取る。前段の job 名がリポジトリごとに違っても同じスクリプトで動く。
e2e_result=$(jq -r '.e2e.result' <<<"$NEEDS_JSON")
others=$(jq -r 'to_entries | map(select(.key != "e2e")) | map("\(.key)=\(.value.result)") | join(" / ")' <<<"$NEEDS_JSON")
case "$e2e_result" in
  success)   icon="✅"; label="成功" ;;
  failure)   icon="❌"; label="失敗" ;;
  cancelled) icon="⚠️"; label="キャンセル" ;;
  skipped)   icon="⚠️"; label="未実行（前段の job が失敗）" ;;
  *)         icon="⚠️"; label="不明（$e2e_result）" ;;
esac
case "$EVENT_NAME" in
  schedule) trigger="定期実行（毎週）" ;;
  *)        trigger="手動実行" ;;
esac
text=$(printf '%s %s E2E %s: *%s*\n実行契機: %s\nブランチ: %s / コミット: %s\n前段: %s\n詳細（Playwright レポートは Artifacts）: %s' \
  "$icon" "$REPO_NAME" "$label" "$e2e_result" "$trigger" "$REF_NAME" "${SHA:0:7}" "$others" "$RUN_URL")
# jq で組み立てるのは、ブランチ名の引用符・改行で JSON が壊れないようにするため。
payload=$(jq -n --arg text "$text" '{text: $text}')
# --fail-with-body が無いと、HTTP 403（token 誤り等）でも curl の終了コードが 0 になり通知失敗に気づけない。
# 応答本文は捨てる（メッセージ内容が返るだけで、ログに残す必要がない）。
curl -sS --fail-with-body --max-time 30 \
  --retry 2 --retry-delay 2 --retry-all-errors \
  -H 'Content-Type: application/json; charset=UTF-8' \
  -o /dev/null -d "$payload" "$WEBHOOK_URL"
