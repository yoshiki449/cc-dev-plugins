#!/bin/bash
# Edit/Write後の自動フォーマットフック
# 変更されたファイルの拡張子に応じて適切なフォーマッターを実行する
INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

[ -z "$FILE_PATH" ] && exit 0
[ ! -f "$FILE_PATH" ] && exit 0

EXT="${FILE_PATH##*.}"

case "$EXT" in
  ts|tsx|js|jsx|json|css|scss|html|md)
    # Prettier（node_modulesがあるディレクトリを探す）
    DIR="$FILE_PATH"
    while [ "$DIR" != "/" ]; do
      DIR=$(dirname "$DIR")
      if [ -f "$DIR/node_modules/.bin/prettier" ]; then
        "$DIR/node_modules/.bin/prettier" --write "$FILE_PATH" 2>/dev/null
        break
      fi
    done
    ;;
  go)
    # gofmt（ホスト側にgoがない場合はスキップ）
    if command -v gofmt &>/dev/null; then
      gofmt -w "$FILE_PATH" 2>/dev/null
    fi
    ;;
esac

exit 0
