#!/usr/bin/env python3
"""marketplace リポジトリのパスを ~/.cc-plugins/.env から解決して出力する。

marketplace が2本あり、どちらへ移植するかは実行時に決まる。パスをコマンドの手順書に
書き込むと、他の環境で動かないうえ、書いた人のディレクトリ構成がそのまま公開される。

使い方:
    python3 marketplace_dirs.py                 # 両方を NAME=PATH 形式で出力
    python3 marketplace_dirs.py --key public    # 公開側のパスだけ出力
    python3 marketplace_dirs.py --key private   # 私有側のパスだけ出力

未設定・実在しない・marketplace でない場合は exit 2 で止める。既定値は持たない。
推測でどこかのパスへ移植すると、社内資産が公開リポジトリへ入る経路になる。
"""

import argparse
import os
import sys
from pathlib import Path

ENV_FILE = Path.home() / ".cc-plugins" / ".env"

KEYS = {
    "public": ("CC_DEV_PLUGINS_DIR", "公開 marketplace（dev-flow / poc-flow / cc-meta / git-secret-guard）"),
    "private": ("CC_PLUGINS_DIR", "私有 marketplace（業務固有の plugin）"),
}


def _load_env_file(path):
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def resolve(kind):
    var, label = KEYS[kind]
    raw = os.environ.get(var)
    if not raw:
        print(
            f"ERROR: 環境変数 {var} が未設定（{label}）。\n"
            f"  {ENV_FILE} に次の行を追記してください:\n"
            f"    {var}=<リポジトリの絶対パス>",
            file=sys.stderr,
        )
        sys.exit(2)
    path = Path(raw).expanduser()
    if not (path / ".claude-plugin" / "marketplace.json").exists():
        print(
            f"ERROR: {var}={path} は marketplace リポジトリではない"
            f"（.claude-plugin/marketplace.json が無い）。",
            file=sys.stderr,
        )
        sys.exit(2)
    return path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--key", choices=sorted(KEYS), help="片方だけパスを出力する")
    args = parser.parse_args()

    _load_env_file(ENV_FILE)

    if args.key:
        print(resolve(args.key))
        return
    for kind in ("public", "private"):
        print(f"{KEYS[kind][0]}={resolve(kind)}")


if __name__ == "__main__":
    main()
