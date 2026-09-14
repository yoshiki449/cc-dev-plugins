#!/bin/bash
# クラウド環境セットアップスクリプト（cloud-env-setup スキル生成テンプレート）
# root / Ubuntu 24.04 で、Claude Code の起動前に実行される。環境キャッシュが無いとき（初回・この欄か
# 許可ホストを変えたとき・約7日ごと）だけ走り、書いたファイルはスナップショットとして次のセッションに残る。
# git・gh・jq・ripgrep・docker・python(pip/uv)・node はプリインストール済みなので「足りないもの」だけ入れる。
# 約5分以内に終わらないとキャッシュが作れないので並列化する。非ゼロ終了はセッション起動を失敗させるので || true する。
# ここでは環境変数が使えない（セッション起動後のシェルにだけ入る）。
# 参考: https://code.claude.com/docs/en/cloud-environments#setup-scripts

# --- 以下は該当リポジトリのときだけコメントを外す ---

# E2E テスト（Playwright）があるリポジトリ: ブラウザ本体＋日本語フォント
# ⚠ ブラウザの配布元は Trusted の許可リストに無い。環境の Network access を Custom にして
#    「既定のリストを含める」＋ cdn.playwright.dev / playwright.download.prss.microsoft.com を足す
# ⚠ 版はリポジトリの @playwright/test（playwright MCP も使うならその playwright-core）に揃える。
#    別の版を入れると実行時に「Executable doesn't exist」になる
# ( npx -y playwright@<版> install --with-deps chromium ) || true &
# ( apt-get update -qq && apt-get install -y --no-install-recommends fonts-noto-cjk fonts-noto-color-emoji fontconfig ) || true &

# docker compose を使うリポジトリ: イメージを先に取ってキャッシュに載せる
# 作業ディレクトリに依存しないよう、compose ファイルは読まずにイメージ名を並べる
# ( for img in <イメージ名:タグ> ...; do docker pull "$img"; done ) || true &

wait
echo "setup script done"
