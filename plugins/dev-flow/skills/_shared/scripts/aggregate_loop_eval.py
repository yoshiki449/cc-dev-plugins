#!/usr/bin/env python3
"""用途: /loop-eval の結果を集計し benchmark.json / benchmark.md を生成する。

skill-creator の aggregate_benchmark.py 相当。標準ライブラリのみ使用。

使い方:
    python3 aggregate_loop_eval.py <results_root>

<results_root> の想定レイアウト:
    <results_root>/<config>/<scenario>/run-<N>/grading.json   (grader が出力)
    <results_root>/<config>/<scenario>/run-<N>/metrics.json   (runner が出力)

出力: <results_root>/benchmark.json と <results_root>/benchmark.md
config が2つ以上あれば最初の2つの delta を出す（current vs candidate）。
"""
import json
import math
import sys
from pathlib import Path


def stats(values):
    """mean / stddev(n-1) / min / max。空なら None。"""
    vals = [v for v in values if v is not None]
    if not vals:
        return None
    mean = sum(vals) / len(vals)
    if len(vals) > 1:
        var = sum((v - mean) ** 2 for v in vals) / (len(vals) - 1)
        stddev = math.sqrt(var)
    else:
        stddev = 0.0
    return {"mean": round(mean, 4), "stddev": round(stddev, 4),
            "min": round(min(vals), 4), "max": round(max(vals), 4), "n": len(vals)}


def load_json(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def collect(root: Path):
    """config → scenario → run のメトリクスを収集する。"""
    data = {}
    # "current"（ベースライン）を先頭に固定し、Delta が「current → candidate の変化」になるようにする
    config_dirs = sorted((p for p in root.iterdir() if p.is_dir()),
                         key=lambda p: (p.name != "current", p.name))
    for config_dir in config_dirs:
        runs = []
        for grading_path in sorted(config_dir.glob("*/run-*/grading.json")):
            run_dir = grading_path.parent
            grading = load_json(grading_path) or {}
            metrics = load_json(run_dir / "metrics.json") or {}
            summary = grading.get("summary", {})
            runs.append({
                "scenario": run_dir.parent.name,
                "run": run_dir.name,
                "pass_rate": summary.get("pass_rate"),
                "passed": summary.get("passed"),
                "total": summary.get("total"),
                "cost_usd": metrics.get("total_cost_usd"),
                "duration_ms": metrics.get("duration_ms"),
                "num_turns": metrics.get("num_turns"),
            })
        if runs:
            data[config_dir.name] = runs
    return data


def delta_str(a, b):
    if a is None or b is None:
        return "n/a"
    d = b - a
    return f"{d:+.4f}".rstrip("0").rstrip(".") or "0"


def main():
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        sys.exit(1)
    root = Path(sys.argv[1])
    if not root.is_dir():
        print(f"ERROR: {root} が存在しません", file=sys.stderr)
        sys.exit(1)

    data = collect(root)
    if not data:
        print("ERROR: grading.json が1件も見つかりません（<config>/<scenario>/run-N/grading.json）", file=sys.stderr)
        sys.exit(1)

    metric_keys = ["pass_rate", "cost_usd", "duration_ms", "num_turns"]
    summary = {}
    for config, runs in data.items():
        summary[config] = {k: stats([r.get(k) for r in runs]) for k in metric_keys}
        # シナリオ別内訳
        scenarios = {}
        for r in runs:
            scenarios.setdefault(r["scenario"], []).append(r.get("pass_rate"))
        summary[config]["per_scenario_pass_rate"] = {
            s: stats(v) for s, v in scenarios.items()
        }

    configs = list(data.keys())
    deltas = {}
    if len(configs) >= 2:
        a, b = configs[0], configs[1]
        for k in metric_keys:
            sa, sb = summary[a].get(k), summary[b].get(k)
            deltas[k] = delta_str(sa and sa["mean"], sb and sb["mean"])

    benchmark = {"configs": configs, "runs": data, "summary": summary, "deltas": deltas}
    (root / "benchmark.json").write_text(
        json.dumps(benchmark, ensure_ascii=False, indent=2), encoding="utf-8")

    # Markdown レポート
    lines = ["# Loop Eval Benchmark", ""]
    header = "| Metric | " + " | ".join(configs)
    if deltas:
        header += " | Delta |"
    else:
        header += " |"
    lines.append(header)
    lines.append("|---" * (len(configs) + 1 + (1 if deltas else 0)) + "|")
    for k in metric_keys:
        row = [k]
        for c in configs:
            s = summary[c].get(k)
            row.append(f"{s['mean']} ± {s['stddev']} (n={s['n']})" if s else "n/a")
        if deltas:
            row.append(deltas.get(k, "n/a"))
        lines.append("| " + " | ".join(str(x) for x in row) + " |")
    lines.append("")
    for c in configs:
        lines.append(f"## {c}: シナリオ別 pass_rate")
        lines.append("")
        for s, st in summary[c]["per_scenario_pass_rate"].items():
            if st:
                lines.append(f"- {s}: {st['mean']} ± {st['stddev']} (n={st['n']})")
            else:
                lines.append(f"- {s}: n/a")
        lines.append("")
    (root / "benchmark.md").write_text("\n".join(lines), encoding="utf-8")
    print(str(root / "benchmark.md"))


if __name__ == "__main__":
    main()
