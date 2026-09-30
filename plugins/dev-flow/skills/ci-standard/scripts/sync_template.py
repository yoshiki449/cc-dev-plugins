#!/usr/bin/env python3
"""templates/notify-e2e.sh を templates/ci-standard.yml の通知 step に写す。

標準の通知スクリプトは 2 か所（単体ファイルとテンプレート内）に持つ。
単体ファイルが正準で、テンプレートはこのスクリプトで同期する。
`--check` は差があれば終了コード 1（テストが使う）。
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "templates" / "notify-e2e.sh"
TEMPLATE = ROOT / "templates" / "ci-standard.yml"
INDENT = " " * 10
# `run: |` の直後から、インデントが 10 未満に戻る行（または EOF）までを置き換える。
BLOCK = re.compile(r"(?P<head>^        run: \|\n)(?P<body>(?:^(?:" + INDENT + r".*)?\n)+)", re.M)


def render() -> str:
    body = "".join(
        (INDENT + line if line.strip() else "") + "\n"
        for line in SCRIPT.read_text(encoding="utf-8").rstrip("\n").split("\n")
    )
    text = TEMPLATE.read_text(encoding="utf-8")
    blocks = list(BLOCK.finditer(text))
    notify = [m for m in blocks if m.start() > text.index("name: Post result to Google Chat")]
    if len(notify) != 1:
        raise SystemExit("通知 step の run ブロックが 1 つに定まりません")
    m = notify[0]
    return text[: m.start("body")] + body + text[m.end("body"):]


def main() -> int:
    rendered = render()
    if "--check" in sys.argv:
        return 0 if rendered == TEMPLATE.read_text(encoding="utf-8") else 1
    TEMPLATE.write_text(rendered, encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
