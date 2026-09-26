"""Check public answer, canonical tool use, and exact scratch-workspace effects."""

from __future__ import annotations

import hashlib
from pathlib import Path
import re
from typing import Any


def workspace_hashes(root: Path) -> dict[str, str]:
    result = {}
    for path in root.rglob("*"):
        if path.is_symlink():
            raise ValueError("scratch workspace symlink is unsupported")
        if path.is_file():
            relative = path.relative_to(root).as_posix()
            if relative.startswith(".git/"):
                continue
            result[relative] = hashlib.sha256(path.read_bytes()).hexdigest()
    return result


def _plain_answer(text: str) -> str:
    stripped = text.strip()
    if stripped.startswith("```") and stripped.endswith("```"):
        lines = stripped.splitlines()
        if len(lines) >= 3:
            stripped = "\n".join(lines[1:-1]).strip()
    for pattern in (r"^\*\*(.+)\*\*$", r"^`(.+)`$", r"^\*(.+)\*$"):
        match = re.fullmatch(pattern, stripped, re.S)
        if match:
            stripped = match.group(1).strip()
    return stripped


def _meeting_roles_are_correct(answer: str) -> bool:
    current = r"(?:현재|최신|새(?:로운)?|current|latest|new|now)"
    retired = r"(?:이전|기존|옛|폐기|취소|retired|old|previous|former)"
    def associated_number(role: str) -> str | None:
        after = re.search(role + r"[^0-9\n.!?]{0,30}(301|417)", answer, re.I)
        if after:
            return after.group(1)
        before = re.search(r"(301|417)(?:번|호)?(?:은|는|이|가)?\s*" + role, answer, re.I)
        return before.group(1) if before else None

    changed = re.search(r"301[^\n.!?]{0,30}(?:에서|→|->|to)[^\n.!?]{0,30}417", answer, re.I)
    obsolete_301 = re.search(r"301(?:번|호)?(?:은|는|이|가)?\s*(?:폐기|취소|retired)", answer, re.I)
    return bool((associated_number(current) == "417" and associated_number(retired) == "301")
                or (changed and obsolete_301 and associated_number(current) != "301"))


def assess_case(case: dict[str, Any], final_text: str | None, terminal_state: str | None,
                tools: dict[str, Any], before: dict[str, str], after: dict[str, str]) -> list[str]:
    failures = []
    case_id = case["id"]
    answer = _plain_answer(final_text or "")
    if terminal_state != "delivered" or final_text is None:
        failures.append("durable_terminal_missing")
    if tools.get("status") != "observed":
        failures.append("tool_evidence_unavailable")
    else:
        completed = {row["tool_name"] for row in tools["calls"] if row["status"] == "completed"}
        if not ({"query_memory", "recall_memory"} & completed):
            failures.append("memory_lookup_missing")
        if "read_conversation_session" not in completed or not tools["canonical_sources_complete"]:
            failures.append("canonical_read_missing")
        needed = {"run_command"} if case_id == 10 else set()
        if not needed.issubset(completed):
            failures.append("required_tool_missing")
        if any(row["status"] == "failed" for row in tools["calls"]):
            failures.append("tool_failed")
    if case_id == 1 and answer != "CEDAR-4821":
        failures.append("answer_incorrect")
    if case_id == 2 and not all(token in answer for token in ("은하수", "목요일")):
        failures.append("answer_incorrect")
    if case_id == 3 and not _meeting_roles_are_correct(answer):
        failures.append("meeting_roles_incorrect")
    if case_id == 4 and answer != "item\tstatus\towner":
        failures.append("answer_incorrect")
    if case_id == 5 and not all(token in answer for token in ("Orchid", "23", "LANTERN", "violet")):
        failures.append("answer_incorrect")
    if case_id == 6 and not all(token in answer for token in ("KITE-903", "B12")):
        failures.append("answer_incorrect")
    if case_id in (1, 6) and ("CEDAR-4281" in answer or "C07" in answer):
        failures.append("retired_fact_used")
    if any(marker in answer for marker in ("/Users/", "/private/tmp/")):
        failures.append("private_path_leaked")
    changed = {path for path in before.keys() | after.keys() if before.get(path) != after.get(path)}
    output = case.get("output")
    allowed = {output["path"]} if output else set()
    if changed != allowed:
        failures.append("workspace_diff_unexpected")
    if output:
        actual_sha = after.get(output["path"])
        if case_id == 10:
            allowed_sha = {
                hashlib.sha256(value).hexdigest()
                for value in (b"KITE-903 B12", b"KITE-903 B12\n")
            }
            if actual_sha not in allowed_sha:
                failures.append("output_hash_incorrect")
            if not actual_sha or actual_sha not in answer:
                failures.append("command_hash_answer_missing")
            if tools.get("command_hash_observed") is not True:
                failures.append("command_hash_tool_output_missing")
        elif actual_sha != output["sha256"]:
            failures.append("output_hash_incorrect")
    return sorted(set(failures))
