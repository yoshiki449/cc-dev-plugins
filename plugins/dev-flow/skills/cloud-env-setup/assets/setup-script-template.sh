#!/bin/bash
# クラウド環境セットアップスクリプト（cloud-env-setup スキル生成テンプレート）
# root / Ubuntu 24.04 で、Claude Code の起動前に実行される。環境キャッシュが無いとき（初回・この欄か
# 許可ホストを変えたとき・約7日ごと）だけ走り、書いたファイルはスナップショットとして次のセッションに残る。
# 約5分以内に終わらないとキャッシュが作れない。非ゼロ終了はセッション起動を失敗させるので || true する。
# ここでは環境変数欄の値が使えない（セッション起動後のシェルにだけ入る）。
# 以下は 2026-09 のクラウドセッションで実測した挙動に合わせてある（claude 2.1.270）。
mkdir -p /opt/setup-log

# plugin: リポジトリの .claude/settings.json に宣言してもクラウドでは入らない。
# plugin の読み込みはセッション起動時に1回だけなので、SessionStart hook から入れても間に合わない。
# Claude の起動前に走るここで入れると、そのセッションから使える。
# cc-meta は ~/.cc-plugins/.env が無いと止まるので入れない。
{
  claude plugin marketplace add https://github.com/yoshiki449/cc-dev-plugins.git
  for p in dev-flow poc-flow git-secret-guard; do
    claude plugin install "$p@cc-dev-plugins" --scope user
  done
} > /opt/setup-log/plugin.log 2>&1 || true

# gh と日本語フォントはプリインストールされていない（既定の日本語フォントは中国語フォントに落ちる）。
# ベースイメージにある PPA が 403 で apt-get update が非ゼロ終了するので、&& でつながない
# fonts-noto-cjk を入れても、lang=ja ではプリインストールの中国語フォントが先に選ばれるので、
# 日本語のときだけ Noto Sans CJK JP を先頭にする（欧文の既定フォントは変えない）
(
  apt-get update -qq
  apt-get install -y --no-install-recommends gh fonts-noto-cjk fontconfig
  cat > /etc/fonts/local.conf <<'XML'
<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <match target="pattern">
    <test name="lang" compare="contains"><string>ja</string></test>
    <edit name="family" mode="prepend" binding="strong"><string>Noto Sans CJK JP</string></edit>
  </match>
</fontconfig>
XML
  fc-cache -f
  fc-match sans-serif:lang=ja
) > /opt/setup-log/apt.log 2>&1 || true &

# MCP: 複数リポジトリを付けたセッションではリポジトリの .mcp.json が効かない（作業ディレクトリが
# 各リポジトリの親になる）ので、ここでユーザー単位に登録する。セッション開始時に npx がその場で取得すると、
# ファイルが途中で切れて MCP が起動に失敗することがあり、そのセッションでは再接続されない。
# 版を固定し、起動前に取得し、npm_config_prefer_offline で取得済みのキャッシュから起動させる
# （付けないと npx はキャッシュがあってもレジストリへ問い合わせる）。-e はサーバー名の後ろに置く
# context7 のツールは context7.com の API を呼ぶ。既定の許可リストに無いので Allowed domains に足す
{
  claude mcp add --scope user playwright -e npm_config_prefer_offline=true -- npx -y @playwright/mcp@0.0.80 --caps=devtools --output-dir=/tmp/playwright-mcp
  claude mcp add --scope user context7 -e npm_config_prefer_offline=true -- npx -y @upstash/context7-mcp@4.1.0
  timeout 180 npx -y @playwright/mcp@0.0.80 --version < /dev/null
  timeout 180 npx -y @upstash/context7-mcp@4.1.0 --version < /dev/null
  # MCP のブラウザは playwright MCP が同梱する Playwright の版に合わせる（プリインストール版とは違う）
  timeout 240 npx -y @playwright/mcp@0.0.80 install-browser chrome-for-testing < /dev/null
} > /opt/setup-log/mcp.log 2>&1 || true &

# --- 以下は該当リポジトリのときだけコメントを外す ---

# docker compose を使うリポジトリ: イメージを先に取ってキャッシュに載せる
# ⚠ Docker Hub のイメージ本体は production.cloudfront.docker.com から配られるが、既定の許可リストに無い。
#    環境の Network access を Custom にし「既定のリストを含める」にチェックしてこのドメインを足す
# 作業ディレクトリに依存しないよう、compose ファイルは読まずにイメージ名を並べる
# ( for img in <イメージ名:タグ> ...; do docker pull "$img"; done ) > /opt/setup-log/docker.log 2>&1 || true &

# リポジトリの .mcp.json にも npx で起動する MCP を書く場合（1リポジトリだけのセッション・ローカル用）は、
# 版を上の登録と揃え、各サーバーに "env": {"npm_config_prefer_offline": "true"} を付ける

# 組織固有のQC観点(overlay)をクラウドにも持ち込む場合:
#   ローカルで bash <skill-dir>/scripts/render_qc_overlay_snippet.sh を実行し、
#   出力をこの直前（plugin 導入ブロックの後）に貼る（中身は社内資産なのでテンプレートには書けない）

wait
echo "setup script done"
