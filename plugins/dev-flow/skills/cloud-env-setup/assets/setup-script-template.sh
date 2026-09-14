#!/bin/bash
# クラウド環境セットアップスクリプト（cloud-env-setupスキル生成テンプレート）
# root / Ubuntu 24.04 実行。git・jq・ripgrep・docker・python(pip/uv)・node は既にプリインストール済みなので
# ここでは「足りないもの」だけ入れる。5分予算内に収めるため並列化し、失敗はsessionを落とさないよう || true する。
# 参考: https://code.claude.com/docs/en/claude-code-on-the-web#setup-scripts

# gh CLI（built-in GitHub toolsで足りない `gh release` / `gh workflow run` 等を使うリポジトリのみ必要）
( apt-get update -qq && apt-get install -y --no-install-recommends gh ) || true &

# --- 以下は該当リポジトリのときだけコメントを外す ---

# E2Eテスト（Playwright）があるリポジトリ: ブラウザ本体+日本語フォント
# ( npx playwright install --with-deps chromium ) || true &
# ( apt-get update -qq && apt-get install -y --no-install-recommends fonts-noto-cjk fonts-noto-cjk-extra fonts-noto-color-emoji fontconfig ) || true &

# Google Apps Script / Google Workspace 連携リポジトリ
# ( npm install -g @google/clasp @googleworkspace/cli ) || true &

# docker-compose.yml を使うリポジトリ: イメージを先取りしてキャッシュに乗せる
# [ -f docker-compose.yml ] && ( docker compose pull || docker compose build ) || true &

wait
echo "setup script done"
