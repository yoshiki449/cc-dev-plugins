#!/usr/bin/env python3
"""ローカル ~/.claude/skills/ と cc-plugins 配下を突き合わせて、未判定スキルを一覧表示する。

3状態の判定:
  - 未判定 (UNJUDGED):
      ローカル ~/.claude/skills/<name>/ にあり、`.cc-plugins-keep` マーカー無し、
      かつ **どの marketplace の** plugins/*/skills/<name>/ にも同名スキルが無い
  - ローカル保持判定済み (LOCAL_KEEP):
      ローカルにあり `.cc-plugins-keep` マーカーあり
  - 移植済み (PROMOTED):
      ローカルになく、いずれかの marketplace の plugins/*/skills/<name>/ にある

使い方:
    python3 list_unpromoted.py --cc-plugins <repo1> --cc-plugins <repo2> [--all]

オプション:
    --all   未判定だけでなく、3状態すべてを表示
"""
import argparse
import json
import sys
from pathlib import Path

LOCAL_SKILLS = Path.home() / ".claude" / "skills"
KEEP_MARKER = ".cc-plugins-keep"


def list_local_skills():
    """ローカル ~/.claude/skills/ 直下の **実体ディレクトリ** のスキル一覧。

    シンボリックリンクは外部由来（~/.agents/skills/ 等）の参照であり、
    自作スキルではないため除外する。
    """
    if not LOCAL_SKILLS.is_dir():
        return []
    return sorted(
        d for d in LOCAL_SKILLS.iterdir()
        if d.is_dir()
        and not d.is_symlink()
        and (d / "SKILL.md").exists()
    )


def list_external_symlinks():
    """シンボリックリンクのスキル（外部由来）の名前 → リンク先のマップ。"""
    if not LOCAL_SKILLS.is_dir():
        return {}
    result = {}
    for d in LOCAL_SKILLS.iterdir():
        if d.is_symlink() and d.is_dir():
            try:
                result[d.name] = str(d.resolve())
            except OSError:
                result[d.name] = "(broken link)"
    return result


def list_marketplace_skills(repo_paths):
    """marketplace リポジトリ群の plugins/*/skills/* を走査し、スキル名 → "<repo>/<plugin>" を返す。

    marketplace が2本あるので、片方だけを見ると**もう片方へ移植済みのスキルが「未判定」として
    出続ける**。判定材料は「どこかの marketplace に居るか」なので、渡された全リポジトリを見る。
    """
    result = {}
    for repo in repo_paths:
        plugins_dir = repo / "plugins"
        if not plugins_dir.is_dir():
            continue
        for plugin_dir in plugins_dir.iterdir():
            skills_dir = plugin_dir / "skills"
            if not skills_dir.is_dir():
                continue
            for skill_dir in skills_dir.iterdir():
                if skill_dir.is_dir() and (skill_dir / "SKILL.md").exists():
                    result[skill_dir.name] = f"{repo.name}/{plugin_dir.name}"
    return result


def classify(local_skills, marketplace_skills):
    """各ローカルスキルを3状態に分類。"""
    unjudged, local_keep, promoted_local_residue = [], [], []
    for skill_dir in local_skills:
        name = skill_dir.name
        has_keep = (skill_dir / KEEP_MARKER).exists()
        in_marketplace = name in marketplace_skills
        if has_keep:
            local_keep.append((name, str(skill_dir)))
        elif in_marketplace:
            # 移植済みなのにローカルも残っている → 二重管理状態。要削除
            promoted_local_residue.append((name, str(skill_dir), marketplace_skills[name]))
        else:
            unjudged.append((name, str(skill_dir)))
    # marketplace にあるがローカルには無い（健全な移植済み）
    local_names = {s.name for s in local_skills}
    promoted_clean = [
        (name, plugin) for name, plugin in marketplace_skills.items()
        if name not in local_names
    ]
    return {
        "unjudged": unjudged,
        "local_keep": local_keep,
        "promoted_local_residue": promoted_local_residue,
        "promoted_clean": promoted_clean,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--cc-plugins",
        required=True,
        action="append",
        metavar="PATH",
        help="marketplace リポジトリのパス。2本あるので複数回渡す",
    )
    parser.add_argument("--all", action="store_true", help="未判定以外も全部表示")
    parser.add_argument("--json", action="store_true", help="JSON で出力")
    args = parser.parse_args()

    repos = []
    for raw in args.cc_plugins:
        repo = Path(raw).expanduser().resolve()
        if not (repo / ".claude-plugin" / "marketplace.json").exists():
            print(f"ERROR: {repo} は marketplace リポジトリではない（marketplace.json が見つからない）", file=sys.stderr)
            sys.exit(1)
        repos.append(repo)

    local = list_local_skills()
    marketplace = list_marketplace_skills(repos)
    external = list_external_symlinks()
    result = classify(local, marketplace)
    result["external_symlinks"] = [(name, target) for name, target in external.items()]

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return

    unjudged = result["unjudged"]
    if not unjudged and not args.all:
        print("✓ 未判定スキルはありません。")
        return

    if unjudged:
        print(f"=== 未判定スキル {len(unjudged)}件 ===")
        print("（いずれかの marketplace へ移植するか、/mark-keep でローカル保持判定するか決めてください）")
        for name, path in unjudged:
            print(f"  - {name}")
            print(f"      path: {path}")
    else:
        print("✓ 未判定スキルはありません。")

    if args.all:
        print()
        print(f"=== ローカル保持判定済み {len(result['local_keep'])}件 ===")
        for name, path in result["local_keep"]:
            print(f"  - {name}  ({path})")

        print()
        print(f"=== 移植済み（クリーン） {len(result['promoted_clean'])}件 ===")
        for name, plugin in result["promoted_clean"]:
            print(f"  - {name}  → {plugin}/")

        residue = result["promoted_local_residue"]
        if residue:
            print()
            print(f"⚠ 二重管理状態 {len(residue)}件（移植済みなのにローカルも残っている）")
            for name, path, plugin in residue:
                print(f"  - {name}: ローカル {path} と {plugin}/ の両方に存在")

        ext = result["external_symlinks"]
        if ext:
            print()
            print(f"=== 外部由来（symlink）{len(ext)}件（管理対象外） ===")
            for name, target in ext:
                print(f"  - {name}  → {target}")


if __name__ == "__main__":
    main()
