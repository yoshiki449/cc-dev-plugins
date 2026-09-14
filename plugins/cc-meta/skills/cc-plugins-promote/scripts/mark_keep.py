#!/usr/bin/env python3
"""ローカル ~/.claude/skills/<name>/ に .cc-plugins-keep マーカーを置く（or 解除）。

このマーカーがあるスキルは cc-plugins への「移植しない」判定済みとして扱われ、
list_unpromoted.py の検出から除外される。

使い方:
    python3 mark_keep.py --skill <name>           # マーカー設置
    python3 mark_keep.py --skill <name> --unset   # マーカー解除
"""
import argparse
import re
import sys
from pathlib import Path

LOCAL_SKILLS = Path.home() / ".claude" / "skills"
MARKER = ".cc-plugins-keep"

# 英数字・ドット・ハイフン・アンダースコアのみ。"."/".."/スラッシュ等を排除。
SAFE_NAME = re.compile(r"^[A-Za-z0-9._-]+$")


def safe_name(name: str) -> str:
    if not name or name in (".", "..") or not SAFE_NAME.fullmatch(name):
        print(
            f"ERROR: invalid --skill name {name!r}: 英数字・ドット・ハイフン・アンダースコア以外NG",
            file=sys.stderr,
        )
        sys.exit(2)
    return name


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skill", required=True, help="対象スキル名")
    parser.add_argument("--unset", action="store_true", help="マーカーを解除")
    args = parser.parse_args()

    skill = safe_name(args.skill)
    skill_dir = LOCAL_SKILLS / skill

    # resolve 後も LOCAL_SKILLS の直下であることを確認（symlinkでの迂回を防ぐ）
    if skill_dir.resolve().parent != LOCAL_SKILLS.resolve():
        print(
            f"ERROR: skill_dir がコンテナ外を指している（{skill_dir.resolve()}）",
            file=sys.stderr,
        )
        sys.exit(2)

    if not (skill_dir / "SKILL.md").exists():
        print(f"ERROR: ローカル {skill_dir} が見つからない", file=sys.stderr)
        sys.exit(1)

    marker = skill_dir / MARKER

    if args.unset:
        if marker.exists():
            marker.unlink()
            print(f"✓ マーカー解除: {marker}")
            print("このスキルは再び /promote-check の対象になります。")
        else:
            print(f"  マーカーは元から無し: {marker}")
    else:
        if marker.exists():
            print(f"  マーカーは既に存在: {marker}")
        else:
            marker.write_text("", encoding="utf-8")
            print(f"✓ マーカー設置: {marker}")
            print("このスキルは /promote-check の対象から除外されます。")


if __name__ == "__main__":
    main()
