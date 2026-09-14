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
( apt-get update -qq; apt-get install -y --no-install-recommends gh fonts-noto-cjk fontconfig ) \
  > /opt/setup-log/apt.log 2>&1 || true &

# --- 以下は該当リポジトリのときだけコメントを外す ---

# docker compose を使うリポジトリ: イメージを先に取ってキャッシュに載せる
# ⚠ Docker Hub のイメージ本体は production.cloudfront.docker.com から配られるが、既定の許可リストに無い。
#    環境の Network access を Custom にし「既定のリストを含める」にチェックしてこのドメインを足す
# 作業ディレクトリに依存しないよう、compose ファイルは読まずにイメージ名を並べる
# ( for img in <イメージ名:タグ> ...; do docker pull "$img"; done ) > /opt/setup-log/docker.log 2>&1 || true &

wait
echo "setup script done"
