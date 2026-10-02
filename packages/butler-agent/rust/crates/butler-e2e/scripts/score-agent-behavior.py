"""Rescore captured evidence without model retries. Usage: script RAW_ROOT REPORT_DIR."""
import collections
import json
import pathlib
import statistics
import sys

raw, out = map(pathlib.Path, sys.argv[1:])
out.mkdir(parents=True, exist_ok=True)
cases = json.loads((pathlib.Path(__file__).parents[1] / "fixtures/agent-behavior/scenarios.json").read_text())
cases = {case["id"]: case for case in cases}
replaced = {"APPROVE-SHELL", "RECOVER-READ", "RECOVER-WRITE"}
summary = {}
for version in ("main", "after"):
    initial = json.loads((raw / version / "results.json").read_text())
    revised = json.loads((raw / f"revised-{version}" / "results.json").read_text())
    assert len(initial) == 102 and len(revised) == 9, "comparison incomplete"
    revisions = {row["id"]: row for row in revised}
    results = []
    for original in initial:
        identity = original["id"].rsplit("-", 1)[0]
        row = revisions[original["id"]] if identity in replaced else original.copy()
        case = cases[identity]
        if identity not in replaced and "harness_error" not in row:
            requests = json.loads((raw / version / f'{row["id"]}-requests.json').read_text())
            calls = list(row["calls"])
            for request in requests:
                for item in request.get("input", []):
                    if item.get("type") != "function_call":
                        continue
                    try:
                        args = json.loads(item["arguments"])
                    except json.JSONDecodeError:
                        continue
                    name = item["name"]
                    if name == "tool_call":
                        route = args.get("id", "")
                        name = route.removeprefix("native:") if route.startswith("native:") else "call_mcp_tool"
                    calls.append({"name": name, "args": args})
            # Recompute only selection/argument checks; durable state assertions
            # remain from the original sandbox, whose full output is retained.
            failures = [f for f in row["failures"] if not f.startswith("missing tool ") and ": missing argument class " not in f]
            if "tool" in case:
                allowed = [case["tool"], *case.get("tool_alternatives", [])]
                selected = [call for call in calls if call["name"] in allowed]
                if not selected:
                    failures.append(f'missing tool class {allowed}')
                arg = case.get("argument_contains")
                if arg and not any(arg.lower() in json.dumps(call["args"]).lower() for call in selected) and not any(arg in json.dumps(a) for a in row["approvals"]):
                    failures.append(f'{case["tool"]}: missing argument class {arg}')
            marker = case.get("reply_contains")
            reply = "\n".join(m["text"] for m in row["messages"] if m["role"] == "assistant")
            if marker and marker not in reply and f"reply missing {marker}" not in failures:
                failures.append(f"reply missing {marker}")
            row["failures"] = failures
            row["pass"] = not failures
        if "harness_error" not in row:
            directory = f"revised-{version}" if identity in replaced else version
            requests = json.loads((raw / directory / f'{row["id"]}-requests.json').read_text())
            if "expected_error_code" in case:
                outputs = [json.loads(item["output"]) for request in requests for item in request.get("input", []) if item.get("type") == "function_call_output"]
                exercised = any(output.get("error", {}).get("code") == case["expected_error_code"] for output in outputs)
                row["failures"] = [failure for failure in row["failures"] if failure != "fault was not exercised"]
                if not exercised:
                    row["failures"].append(f'missing injected error {case["expected_error_code"]}')
            marker = case.get("reply_contains_insensitive")
            reply = "\n".join(m["text"] for m in row["messages"] if m["role"] == "assistant")
            if marker and marker.lower() not in reply.lower():
                row["failures"].append(f"reply missing {marker}")
            row["pass"] = not row["failures"]
        results.append(row)
    assert len(results) == 102
    categories = collections.defaultdict(list)
    for row in results:
        categories[row["category"]].append(row)
        if not row["pass"]:
            (out / f'{version}-{row["id"]}.json').write_text(json.dumps(row, ensure_ascii=False, indent=2) + "\n")
    summary[version] = {
        "passed": sum(row["pass"] for row in results), "total": len(results),
        "categories": {key: {"passed": sum(row["pass"] for row in rows), "total": len(rows), "failures": [row["id"] for row in rows if not row["pass"]]} for key, rows in sorted(categories.items())},
        "first_request_tokens_mean": statistics.mean(row["request_tokens"][0]["serialized"] for row in results),
        "request_tokens_total": sum(token["serialized"] for row in results for token in row["request_tokens"]),
    }
    (out / f"{version}-results.json").write_text(json.dumps(results, ensure_ascii=False, indent=2) + "\n")
(out / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
print(json.dumps(summary, indent=2))
