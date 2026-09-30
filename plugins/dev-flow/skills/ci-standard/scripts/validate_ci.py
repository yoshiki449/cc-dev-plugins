#!/usr/bin/env python3
"""GitHub Actions のワークフローが ci-standard に適合しているかを静的に検査する。

    python3 validate_ci.py .github/workflows/ci.yml

終了コード: 0=適合（警告は出うる） / 1=不適合（[NG] あり） / 2=読み込み・使い方の誤り。

ルール（根拠は references/rationale.md）:
  R0 標準の印（`# ci-standard: vN`）がある                       （警告のみ）
  R1 docs 系だけの変更で起動しない。コードの変更は取りこぼさない
  R2 concurrency は PR ごと・commit ごとの group で、キャンセルは PR のみ
  R3 e2e job は schedule / workflow_dispatch のときだけ走る          （例外で免除）
  R4 schedule は週 1 回の cron が 1 本                              （例外で免除）
  R5 notify-e2e job が正準の形で結果を通知する                       （例外で免除）
  R6 全 job に timeout-minutes（1〜30）
  R7 e2e の前段 job に `if` を付けない（PR・push の品質ゲート）     （例外で免除）
  R8 e2e job があり、前段 job に依存する                            （例外で免除）
  R9 例外を宣言するなら理由を書く

例外: ワークフロー冒頭に `# ci-standard-exception: <理由>` を書くと R3〜R5・R7・R8 を免除する。
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

try:
    import yaml
except ImportError:  # pragma: no cover - 環境依存
    print("PyYAML が必要です: pip install pyyaml", file=sys.stderr)
    raise SystemExit(2)

CURRENT_VERSION = 1
ROOT = Path(__file__).resolve().parent.parent
CANONICAL_NOTIFY = ROOT / "templates" / "notify-e2e.sh"

DOCS_PATTERNS = ["**/*.md", "docs/**", ".agent/**", ".claude/**"]
DOCS_PATHS = ["README.md", "docs/DESIGN.md", "sub/README.md", ".agent/handover/x.md", ".claude/settings.json"]
# 変更されたら CI を起動しなければならないパスの代表例（allowlist 方式で列挙）。
CODE_PATHS = [
    "src/index.ts",
    "app/main.py",
    "backend/app/main.py",
    "frontend/src/App.tsx",
    "tests/test_x.py",
    "e2e/tests/a.spec.ts",
    "infra/docker-compose.yml",
    "package.json",
    "package-lock.json",
    "pyproject.toml",
    "go.mod",
    "Dockerfile",
    ".github/workflows/ci.yml",
]
EXCEPTION_WAIVES = {"R3", "R4", "R5", "R7", "R8"}
E2E_EVENTS = {"schedule", "workflow_dispatch"}
NOTIFY_JOB = "notify-e2e"
E2E_JOB = "e2e"
MAX_TIMEOUT = 30


class Report:
    def __init__(self, exception: str | None) -> None:
        self.exception = exception
        self.lines: list[tuple[str, str, str]] = []  # (level, rule, message)

    def ng(self, rule: str, message: str) -> None:
        if self.exception is not None and rule in EXCEPTION_WAIVES:
            self.lines.append(("例外", rule, f"{message}（例外: {self.exception}）"))
        else:
            self.lines.append(("NG", rule, message))

    def warn(self, rule: str, message: str) -> None:
        self.lines.append(("警告", rule, message))

    def ok(self, rule: str, message: str) -> None:
        self.lines.append(("OK", rule, message))

    @property
    def failed(self) -> bool:
        return any(level == "NG" for level, _, _ in self.lines)


def glob_to_regex(pattern: str) -> re.Pattern[str]:
    """GitHub Actions の paths フィルタ記法（`**` `*`）を正規表現にする。"""
    out, i = [], 0
    while i < len(pattern):
        if pattern.startswith("**/", i):
            out.append("(?:.*/)?")
            i += 3
        elif pattern.startswith("**", i):
            out.append(".*")
            i += 2
        elif pattern[i] == "*":
            out.append("[^/]*")
            i += 1
        else:
            out.append(re.escape(pattern[i]))
            i += 1
    return re.compile("".join(out) + r"\Z")


def is_ignored(path: str, patterns: list[str]) -> bool:
    return any(glob_to_regex(p).match(path) for p in patterns)


def events_in_if(condition: str) -> set[str] | None:
    """`github.event_name == 'a' || github.event_name == 'b'` からイベント名の集合を取る。
    この形式以外は None（想定外）。"""
    events = set()
    for part in (p.strip() for p in condition.split("||")):
        m = re.fullmatch(r"github\.event_name == '([a-z_]+)'", part)
        if not m:
            return None
        events.add(m.group(1))
    return events


def dedent(text: str) -> str:
    return text.strip("\n").rstrip()


def check_docs_skip(report: Report, triggers: dict) -> None:
    problems = []
    for event in ("pull_request", "push"):
        cfg = triggers.get(event)
        ignore = (cfg or {}).get("paths-ignore") if isinstance(cfg, dict) else None
        if not ignore:
            problems.append(f"{event} に paths-ignore が無い")
            continue
        missing = [p for p in DOCS_PATTERNS if p not in ignore]
        if missing:
            problems.append(f"{event} の paths-ignore に {missing} が無い")
        for path in DOCS_PATHS:
            if not is_ignored(path, ignore):
                problems.append(f"{event}: docs 系の {path} で CI が起動する")
        for path in CODE_PATHS:
            if is_ignored(path, ignore):
                problems.append(f"{event}: コードの {path} を変更しても CI が起動しない")
    if problems:
        report.ng("R1", "; ".join(problems))
    else:
        report.ok("R1", "docs 系だけの変更では起動せず、コードの変更は取りこぼさない")


def check_concurrency(report: Report, wf: dict) -> None:
    conc = wf.get("concurrency")
    if not isinstance(conc, dict):
        report.ng("R2", "concurrency が無い")
        return
    group = str(conc.get("group", ""))
    cancel = conc.get("cancel-in-progress")
    problems = []
    if "github.event.pull_request.number" not in group or "github.sha" not in group:
        problems.append("group が PR 番号（PR 以外は github.sha）単位になっていない（ref 単位だと連続マージで main の検証が消える）")
    if cancel != "${{ github.event_name == 'pull_request' }}":
        problems.append("cancel-in-progress が PR のみになっていない")
    if problems:
        report.ng("R2", "; ".join(problems))
    else:
        report.ok("R2", "キャンセルは PR のみ。main への push は commit ごとに検証する")


def check_e2e_trigger(report: Report, jobs: dict) -> None:
    e2e = jobs.get(E2E_JOB)
    if not isinstance(e2e, dict):
        return  # R8 が報告する
    events = events_in_if(str(e2e.get("if", "")))
    if events != E2E_EVENTS:
        report.ng("R3", f"e2e の if が schedule / workflow_dispatch のみになっていない（現在: {e2e.get('if')!r}）")
    else:
        report.ok("R3", "e2e は週次・手動のときだけ走る")


def check_schedule(report: Report, triggers: dict) -> None:
    schedules = triggers.get("schedule")
    if not isinstance(schedules, list) or len(schedules) != 1:
        report.ng("R4", "schedule の cron が 1 本ではない")
        return
    parts = str(schedules[0].get("cron", "")).split()
    if len(parts) != 5:
        report.ng("R4", "cron の形式が不正")
        return
    minute, hour, dom, month, dow = parts
    if not (minute.isdigit() and hour.isdigit()):
        report.ng("R4", "分・時が固定でない（毎時・毎分実行になる）")
    elif dom != "*" or month != "*" or not (dow.isdigit() and 0 <= int(dow) <= 6):
        report.ng("R4", "週 1 回（曜日を 1 つに固定）になっていない")
    else:
        report.ok("R4", "週 1 回の定期実行")


def check_notify(report: Report, wf: dict, raw: str) -> None:
    jobs = wf["jobs"]
    job = jobs.get(NOTIFY_JOB)
    problems = []
    if re.search(r"chat\.googleapis\.com|[?&](key|token)=", raw):
        problems.append("Webhook URL（key / token）がコードに書かれている")
    if not isinstance(job, dict):
        problems.append(f"{NOTIFY_JOB} job が無い")
        report.ng("R5", "; ".join(problems))
        return
    cond = str(job.get("if", ""))
    m = re.fullmatch(r"always\(\) && \((.+)\)", cond)
    if not m or events_in_if(m.group(1)) != E2E_EVENTS:
        problems.append("if が `always() && (schedule || workflow_dispatch)` になっていない（always() が無いと失敗を通知できない）")
    needs = set(job.get("needs") or [])
    e2e = jobs.get(E2E_JOB) or {}
    expected = {E2E_JOB} | set(e2e.get("needs") or [])
    if not expected <= needs:
        problems.append(f"needs に {sorted(expected - needs)} が無い")
    if job.get("permissions") != {}:
        problems.append("permissions が {} でない")
    if int(job.get("timeout-minutes", 0) or 0) <= 0:
        pass  # R6 が報告する
    steps = [s for s in job.get("steps", []) if "Google Chat" in str(s.get("name", ""))]
    if len(steps) != 1:
        problems.append("Google Chat への通知 step が 1 つに定まらない")
    else:
        step = steps[0]
        env = step.get("env") or {}
        if env.get("WEBHOOK_URL") != "${{ secrets.GOOGLE_CHAT_WEBHOOK_URL }}":
            problems.append("WEBHOOK_URL が Secret GOOGLE_CHAT_WEBHOOK_URL から読まれていない")
        script = str(step.get("run", ""))
        if "${{" in script:
            problems.append("スクリプトに式（${{ }}）が直接埋め込まれている（スクリプトインジェクション）")
        if CANONICAL_NOTIFY.is_file() and dedent(script) != dedent(CANONICAL_NOTIFY.read_text(encoding="utf-8")):
            problems.append("通知スクリプトが標準（templates/notify-e2e.sh）から変更されている")
    if problems:
        report.ng("R5", "; ".join(problems))
    else:
        report.ok("R5", "E2E の結果を通知する（失敗・未実行も通知。URL は Secret）")


def check_timeouts(report: Report, jobs: dict) -> None:
    bad = []
    for name, job in jobs.items():
        timeout = job.get("timeout-minutes") if isinstance(job, dict) else None
        if not isinstance(timeout, int) or isinstance(timeout, bool) or not 1 <= timeout <= MAX_TIMEOUT:
            bad.append(f"{name}={timeout!r}")
    if bad:
        report.ng("R6", f"timeout-minutes が未設定または 1〜{MAX_TIMEOUT} の範囲外: {', '.join(bad)}")
    else:
        report.ok("R6", "全 job に timeout-minutes")


def check_gate_jobs(report: Report, jobs: dict) -> None:
    e2e = jobs.get(E2E_JOB)
    if not isinstance(e2e, dict):
        return
    gated = [n for n in (e2e.get("needs") or []) if isinstance(jobs.get(n), dict) and "if" in jobs[n]]
    if gated:
        report.ng("R7", f"前段 job に if が付いている（PR・push で毎回走らなくなる）: {', '.join(gated)}")
    else:
        report.ok("R7", "前段 job は PR・push で毎回走る")


def check_e2e_job(report: Report, jobs: dict) -> None:
    e2e = jobs.get(E2E_JOB)
    if not isinstance(e2e, dict):
        report.ng("R8", f"{E2E_JOB} job が無い（E2E が無いリポジトリは ci-standard-exception に理由を書く）")
    elif not e2e.get("needs"):
        report.ng("R8", "e2e が前段 job に依存していない（前段が失敗した run で E2E の課金が発生する）")
    else:
        report.ok("R8", "e2e は前段 job の成功後にだけ走る")


def validate(raw: str) -> Report:
    header_exc = re.search(r"^#\s*ci-standard-exception:[ \t]*(.*)$", raw, re.M)
    exception = header_exc.group(1).strip() if header_exc else None
    report = Report(exception if exception else None)

    stamp = re.search(r"^#\s*ci-standard:\s*v(\d+)", raw, re.M)
    if not stamp:
        report.warn("R0", "標準の印（# ci-standard: v1）が無い")
    elif int(stamp.group(1)) < CURRENT_VERSION:
        report.warn("R0", f"標準の版が古い（v{stamp.group(1)} < v{CURRENT_VERSION}）")
    if header_exc is not None:
        if exception:
            report.warn("R9", f"例外を適用中: {exception}")
        else:
            report.ng("R9", "ci-standard-exception に理由が書かれていない")

    wf = yaml.safe_load(raw)
    if not isinstance(wf, dict) or not isinstance(wf.get("jobs"), dict):
        report.ng("R8", "ワークフローとして読めない（jobs が無い）")
        return report
    triggers = wf["on"] if "on" in wf else wf.get(True, {})  # YAML 1.1 では on が True になる
    triggers = triggers if isinstance(triggers, dict) else {}
    jobs = wf["jobs"]

    check_docs_skip(report, triggers)
    check_concurrency(report, wf)
    check_e2e_trigger(report, jobs)
    check_schedule(report, triggers)
    check_notify(report, wf, raw)
    check_timeouts(report, jobs)
    check_gate_jobs(report, jobs)
    check_e2e_job(report, jobs)
    return report


def main(argv: list[str]) -> int:
    if len(argv) != 2 or argv[1] in ("-h", "--help"):
        print(__doc__, file=sys.stderr)
        return 2
    path = Path(argv[1])
    try:
        raw = path.read_text(encoding="utf-8")
        report = validate(raw)
    except (OSError, yaml.YAMLError) as e:
        print(f"読み込めません: {path}: {e}", file=sys.stderr)
        return 2
    print(f"ci-standard 検証: {path}")
    for level, rule, message in sorted(report.lines, key=lambda x: x[1]):
        print(f"[{level}] {rule} {message}")
    ng = sum(1 for level, _, _ in report.lines if level == "NG")
    print(f"結果: {'不適合（NG %d 件）' % ng if report.failed else '適合'}")
    return 1 if report.failed else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
