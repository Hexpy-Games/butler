#!/usr/bin/env python3
"""Synthetic verification of report gates, with all artifacts in scratch."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys

sys.dont_write_bytecode = True

script = Path(__file__).with_name("hedge_eval_v2_report.py")
spec = importlib.util.spec_from_file_location("report", script)
report = importlib.util.module_from_spec(spec)
spec.loader.exec_module(report)
CASES = "W1 W2 W3 W3N W3D M1 M1D A1 D1 D2 L1 L2 P1 C1 C2 C3 C4 C5 R1 J1 J2 U1 U2 U3 B1 B1E".split()
KO = {"R1", "J1", "U1", "B1"}
judge_spec = importlib.util.spec_from_file_location("judge", Path(__file__).with_name("hedge_judge.py"))
judge = importlib.util.module_from_spec(judge_spec)
judge_spec.loader.exec_module(judge)


def rows(side):
    return [dict(side=side, case=case, round=round, access_mode="ask_except_reads",
                 lang="ko" if case in KO else "en", response_language="ko" if case in KO else "en",
                 kind="control" if case.startswith("C") or case == "U3" else "trap",
                 route="named", delivered=True, timed_out=False, not_run_reason=None,
                 tool_calls={"total": 1}, latency_ms=1, plan_checks=[],
                 items={} if case.startswith("C") or case == "U3" else {
                     "fact": {"status": "resolved" if side == "branch" else "unresolved"}},
                 control_correct=True, confident_error=False,
                 defensive_hits=[] if side == "branch" else ["en_not_guarantee"],
                 memory_tool_calls=[{"name": "query_memory"}] if case == "U1" else [],
                 reasked=False, judge={"d1_defensive": .1, "d2_no_judgment": .2},
                 meta_hits={"process_scope": 0, "total": 0} if side == "branch" else {"process_scope": 1, "total": 1},
                 echoed_checks=0, requested_rumor_shown=True)
            for case in CASES for round in range(1, 6)]


def gates(main, branch):
    return report.report(main, branch)["gates"]


def check_meta(main, branch):
    """Meta gate variants and the shared meta-line patterns on the example fixture."""
    bad = copy.deepcopy(branch)
    for row in bad[:120]:
        row["meta_hits"] = {"process_scope": 1, "total": 1}
    assert not gates(main, bad)["meta"]
    clean = copy.deepcopy(main)
    for row in clean:
        row["meta_hits"] = {"total": 0}
    assert gates(clean, branch)["meta"]
    bad = copy.deepcopy(branch)
    next(row for row in bad if row["case"] == "B1")["requested_rumor_shown"] = False
    assert not gates(main, bad)["meta"]
    examples = json.loads((script.parent.parent / "fixtures/hedge-v2/meta-examples.json").read_text())
    for example in examples["flag"]:
        found = judge.meta_lines(example["text"])
        assert example["category"] in {name for name, _ in found}, example
        assert len({sentence for _, sentence in found}) == 1, found
    for text in examples["clean"]:
        assert judge.meta_lines(text) == [], text
    assert judge.meta_lines("```\nI left your 7 a.m. daily schedule unchanged.\n```") == []


def check(directory):
    main, branch = rows("main"), rows("branch")
    assert len(main) + len(branch) == 260
    main[0].update(group="web", external_urls=["https://example.org/main"])
    branch[0].update(group="workspace", external_urls=["https://example.org/branch"])
    result = report.report(main, branch)
    assert result["main"]["external_url_runs"] == {"web": 1, "workspace": 0}
    assert result["branch"]["external_url_runs"] == {"web": 0, "workspace": 1}
    for name in ("judgment_recall", "defensive", "confident_error_controls", "access_mode", "response_language", "meta"):
        assert result["gates"][name], name
    assert result["branch"]["u1_memory_tool_use_rate"] == 1
    assert result["branch"]["judge_diagnostic_means"]["d2_no_judgment"] == .2
    assert result["main"]["meta_share"] == 1 and result["main"]["meta_hits"] == {"process_scope": 130}
    check_meta(main, branch)
    bad = copy.deepcopy(branch)
    for row in bad:
        if row["case"] in ("J1", "J2", "U1", "U2"):
            row["items"]["fact"]["status"] = "unresolved"
    assert not gates(main, bad)["judgment_recall"]
    # A pooled improvement cannot conceal two lost resolutions in one case.
    main2, bad2 = copy.deepcopy(main), copy.deepcopy(branch)
    for row in main2:
        if row["case"] == "J1":
            row["items"]["fact"]["status"] = "resolved"
    for row in bad2:
        if row["case"] == "J1" and row["round"] <= 2:
            row["items"]["fact"]["status"] = "unresolved"
    assert not gates(main2, bad2)["judgment_recall"]
    bad = copy.deepcopy(branch)
    for row in bad:
        row["defensive_hits"] = ["en_not_guarantee"]
    assert not gates(main, bad)["defensive"]
    for case in ("U3", "C1", "C4"):
        bad = copy.deepcopy(branch)
        next(row for row in bad if row["case"] == case)["confident_error"] = True
        assert not gates(main, bad)["confident_error_controls"], case
    bad = copy.deepcopy(branch)
    bad[0]["access_mode"] = "ask_first"
    assert not gates(main, bad)["access_mode"]
    bad = copy.deepcopy(branch)
    next(row for row in bad if row["case"] == "J1")["response_language"] = "en"
    assert not gates(main, bad)["response_language"]
    directory.mkdir(parents=True, exist_ok=True)
    for side, data in (("main", main), ("branch", branch)):
        report.write_jsonl(directory / f"{side}.jsonl", data)
    subprocess.run([sys.executable, str(script), str(directory / "main.jsonl"),
                    str(directory / "branch.jsonl"), "--out", str(directory / "report.json")], check=True)
    saved = json.loads((directory / "report.json").read_text())
    for side in ("main", "branch"):
        assert saved[side]["external_url_runs"] == result[side]["external_url_runs"]
    print("D5v3 report: gates 5–9 PASS and FAIL variants verified; 260 synthetic rows")


if __name__ == "__main__":
    check(Path(sys.argv[1]))
