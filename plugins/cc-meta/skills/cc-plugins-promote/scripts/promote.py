#!/usr/bin/env python3
"""ローカル ~/.claude/skills/<name>/ を cc-plugins/plugins/<plugin>/skills/<name>/ に移植する。

機械的なファイル移動・plugin.json 生成 or version bump・marketplace.json 更新・
ローカル削除を行う。最終の git commit / push は呼び出し側 (Claude) が判断する。

使い方:
    python3 promote.py --cc-plugins <repo> --skill <skill-name> --plugin <category-name>
                       [--dry-run]

挙動:
    - <plugin> が既存: skills/ 配下にコピー、plugin.json の version を patch bump
    - <plugin> が新規: スケルトン作成 (plugin.json は 0.1.0)、
                      marketplace.json の plugins[] に追加
    - ローカル ~/.claude/skills/<skill>/ は削除（--dry-run 時は何もしない）
"""
import argparse
import json
import os
import re
import shutil
import sys
from pathlib import Path

LOCAL_SKILLS = Path.home() / ".claude" / "skills"

# ディレクトリ名として許可する文字（英数字・ドット・ハイフン・アンダースコア）
# スラッシュ・空白・"."・".."・NUL等を排除。path traversalを構造的に防ぐ。
SAFE_NAME = re.compile(r"^[A-Za-z0-9._-]+$")


def safe_name(name: str, label: str) -> str:
    """args.skill / args.plugin が安全な単一ディレクトリ名であることを保証する。"""
    if not name or name in (".", "..") or not SAFE_NAME.fullmatch(name):
        print(
            f"ERROR: invalid {label} name {name!r}: 英数字・ドット・ハイフン・アンダースコア以外NG",
            file=sys.stderr,
        )
        sys.exit(2)
    return name


def assert_contained(child: Path, parent: Path, label: str) -> None:
    """resolve した child が parent の直下であることを保証する。"""
    child_r = child.resolve()
    parent_r = parent.resolve()
    if child_r.parent != parent_r:
        print(
            f"ERROR: {label} がコンテナ外を指している（child={child_r}, expected parent={parent_r}）",
            file=sys.stderr,
        )
        sys.exit(2)


def bump_patch(version: str) -> str:
    m = re.match(r"^(\d+)\.(\d+)\.(\d+)(.*)$", version.strip())
    if not m:
        return version
    major, minor, patch, suffix = m.groups()
    return f"{major}.{minor}.{int(patch) + 1}{suffix}"


def update_plugin_json(plugin_root: Path, new: bool):
    plugin_json_path = plugin_root / ".claude-plugin" / "plugin.json"
    if new:
        plugin_json_path.parent.mkdir(parents=True, exist_ok=True)
        plugin_json_path.write_text(
            json.dumps(
                {
                    "name": plugin_root.name,
                    "description": f"{plugin_root.name} カテゴリのスキル集",
                    "version": "0.1.0",
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        return "0.1.0"
    data = json.loads(plugin_json_path.read_text(encoding="utf-8"))
    data["version"] = bump_patch(data.get("version", "0.0.0"))
    plugin_json_path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return data["version"]


def update_marketplace_json(cc_plugins: Path, plugin_name: str):
    mp_path = cc_plugins / ".claude-plugin" / "marketplace.json"
    data = json.loads(mp_path.read_text(encoding="utf-8"))
    plugins = data.setdefault("plugins", [])
    if any(p.get("name") == plugin_name for p in plugins):
        return False
    plugins.append(
        {
            "name": plugin_name,
            "source": f"./plugins/{plugin_name}",
            "description": f"{plugin_name} カテゴリのスキル集",
        }
    )
    mp_path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cc-plugins", required=True, help="cc-plugins リポジトリのパス")
    parser.add_argument("--skill", required=True, help="移植するスキル名")
    parser.add_argument("--plugin", required=True, help="入れる plugin カテゴリ名")
    parser.add_argument("--dry-run", action="store_true", help="変更を加えずプレビュー")
    args = parser.parse_args()

    cc = Path(args.cc_plugins).expanduser().resolve()
    # 入力名を allowlist 検証してから join（path traversal の構造的阻止）
    skill_name = safe_name(args.skill, "--skill")
    plugin_name = safe_name(args.plugin, "--plugin")

    src = LOCAL_SKILLS / skill_name
    plugin_root = cc / "plugins" / plugin_name
    dst = plugin_root / "skills" / skill_name

    # resolve 後も意図したコンテナの直下であることを確認（symlink等での迂回を防ぐ）
    assert_contained(src, LOCAL_SKILLS, "src")
    assert_contained(plugin_root, cc / "plugins", "plugin_root")

    if not (src / "SKILL.md").exists():
        print(f"ERROR: ローカル {src} が見つからない", file=sys.stderr)
        sys.exit(1)
    if dst.exists():
        print(f"ERROR: 移植先 {dst} が既に存在する", file=sys.stderr)
        sys.exit(1)

    plugin_was_new = not plugin_root.exists()

    print(f"src:    {src}")
    print(f"dst:    {dst}")
    print(f"plugin: {args.plugin} ({'新規' if plugin_was_new else '既存'})")

    if args.dry_run:
        print("--dry-run のためここで終了。実行はオプションなしで再度。")
        return

    # 1. ファイルコピー（symlinkは exfiltration リスクのため明示的に拒否）
    dst.mkdir(parents=True, exist_ok=True)
    src_resolved = src.resolve()
    for item in src.iterdir():
        if item.name == ".cc-plugins-keep":
            continue
        if item.is_symlink():
            print(
                f"ERROR: symlink は marketplace への exfiltration リスクのためコピーしない: {item}",
                file=sys.stderr,
            )
            sys.exit(2)
        # resolve 後も src の子孫であることを確認
        item_resolved = item.resolve()
        try:
            item_resolved.relative_to(src_resolved)
        except ValueError:
            print(
                f"ERROR: コピー対象が src 外を指している: {item} → {item_resolved}",
                file=sys.stderr,
            )
            sys.exit(2)
        if item.is_dir():
            # copytree 内部での symlink 追従も止める（symlinks=False のまま、後段はlinkとしてコピー）
            shutil.copytree(item, dst / item.name, symlinks=True)
        else:
            shutil.copy2(item, dst / item.name)
    print(f"  → コピー完了")

    # 2. plugin.json (新規 or version bump)
    new_version = update_plugin_json(plugin_root, plugin_was_new)
    print(f"  → plugin.json version: {new_version}")

    # 3. marketplace.json
    added = update_marketplace_json(cc, args.plugin)
    print(f"  → marketplace.json: {'plugins[]に追加' if added else '既存のため変更なし'}")

    # 4. ローカル削除
    shutil.rmtree(src)
    print(f"  → ローカル {src} を削除")

    print()
    print("=== 移植完了 ===")
    print("次のステップ:")
    print("  1. /reload-plugins （Claude Code 内）")
    print(f"  2. git add . && git commit -m 'promote: {args.skill} → {args.plugin}'")
    print("  3. git push")


if __name__ == "__main__":
    main()
