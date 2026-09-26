"""Read completed production tool journal rows without publishing arguments/results."""

from __future__ import annotations

import json
import hashlib
import re
import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Any


def _duration_ms(started: str, finished: str | None) -> float | None:
    if finished is None:
        return None
    try:
        return max(0.0, (datetime.fromisoformat(finished.replace("Z", "+00:00")) -
                         datetime.fromisoformat(started.replace("Z", "+00:00"))).total_seconds() * 1000)
    except ValueError:
        return None


def inspect_tool_journal(data_root: Path, turn_id: str, expected_source_message_ids: set[str],
                         required_tools: set[str]) -> dict[str, Any]:
    path = data_root / "agent-runtime" / "btcc.sqlite"
    if not path.is_file():
        return {"status": "unavailable", "reason": "tool_journal_missing"}
    try:
        connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        try:
            rows = connection.execute(
                "SELECT tool_name,status,result_json,started_at,finished_at,error_code "
                "FROM btcc_guided_tool_calls WHERE turn_id=? ORDER BY rowid", (turn_id,),
            ).fetchall()
        finally:
            connection.close()
    except sqlite3.Error:
        return {"status": "unavailable", "reason": "tool_journal_query_unavailable"}
    safe_calls = []
    canonical_read_ids: set[str] = set()
    for name, status, result_json, started, finished, error_code in rows:
        if name == "read_conversation_session" and status == "completed" and result_json:
            try:
                result = json.loads(result_json)
                serialized = json.dumps(result, ensure_ascii=False)
                canonical_read_ids.update(message_id for message_id in expected_source_message_ids
                                          if message_id in serialized)
            except (TypeError, ValueError):
                pass
        safe_calls.append({
            "tool_name": name, "status": status,
            "duration_ms": _duration_ms(started, finished),
            "error_code": error_code,
        })
    completed = {row["tool_name"] for row in safe_calls if row["status"] == "completed"}
    return {
        "status": "observed",
        "calls": safe_calls,
        "required_tools_completed": required_tools.issubset(completed),
        "canonical_sources_read": sorted(canonical_read_ids),
        "canonical_sources_complete": expected_source_message_ids.issubset(canonical_read_ids),
    }


def inspect_run_command_hash(data_root: Path, turn_id: str, file_sha256: str) -> bool:
    """Check the actual command stdout (or its exact readback artifact), not arguments."""
    if not re.fullmatch(r"[a-f0-9]{64}", file_sha256):
        return False
    path = data_root / "agent-runtime" / "btcc.sqlite"
    try:
        connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        try:
            rows = connection.execute(
                "SELECT tool_name,status,arguments_json,result_json "
                "FROM btcc_guided_tool_calls WHERE turn_id=? "
                "AND tool_name IN ('run_command','read_tool_output_artifact') ORDER BY rowid",
                (turn_id,),
            ).fetchall()
        finally:
            connection.close()
    except sqlite3.Error:
        return False

    def contains_hash(value: object) -> bool:
        return isinstance(value, str) and bool(re.search(
            rf"(?<![a-f0-9]){file_sha256}(?![a-f0-9])", value,
        ))

    command_artifacts = set()
    readbacks = []
    for name, status, arguments_json, result_json in rows:
        if status != "completed" or not result_json:
            continue
        try:
            result = json.loads(result_json)
            arguments = json.loads(arguments_json) if arguments_json else {}
        except (TypeError, ValueError):
            continue
        if not isinstance(result, dict):
            continue
        if name == "run_command":
            if result.get("ok") is not True or result.get("exit_code") != 0:
                continue
            if contains_hash(result.get("stdout")):
                return True
            artifact = result.get("butler_tool_artifact")
            if isinstance(artifact, dict) and isinstance(artifact.get("id"), str):
                command_artifacts.add(artifact["id"])
        elif isinstance(arguments, dict):
            artifact_id = arguments.get("artifact_id")
            stdout = result.get("stdout")
            readback_text = stdout.get("text") if isinstance(stdout, dict) else stdout
            if isinstance(artifact_id, str) and result.get("ok") is True and \
               contains_hash(readback_text):
                readbacks.append(artifact_id)
    return any(artifact_id in command_artifacts for artifact_id in readbacks)


def inspect_canonical_read_journal(data_root: Path, turn_id: str,
                                  expected_sources: list[dict[str, Any]],
                                  expected_evidence: list[dict[str, str]]) -> dict[str, Any]:
    """Validate installed query/read results from the durable public tool journal."""
    path = data_root / "agent-runtime" / "btcc.sqlite"
    if not path.is_file():
        raise ValueError("guided_tool_journal_missing")
    try:
        connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        connection.row_factory = sqlite3.Row
        try:
            rows = connection.execute(
                "SELECT tool_name,status,arguments_json,result_json,error_code "
                "FROM btcc_guided_tool_calls WHERE turn_id=? ORDER BY rowid", (turn_id,),
            ).fetchall()
        finally:
            connection.close()
    except sqlite3.Error:
        raise ValueError("guided_tool_journal_readback_failed") from None

    relevant = [row for row in rows if row["tool_name"] in {
        "query_memory", "read_conversation_session"}]
    if len(relevant) != 2 * len(expected_sources):
        raise ValueError("guided_tool_journal_call_count_mismatch")
    if [row["tool_name"] for row in relevant] != [
        name for _source in expected_sources
        for name in ("query_memory", "read_conversation_session")
    ]:
        raise ValueError("guided_tool_journal_call_order_mismatch")

    def decode(value: Any) -> Any:
        if not isinstance(value, str):
            raise ValueError("guided_tool_journal_result_missing")
        try:
            return json.loads(value)
        except ValueError:
            raise ValueError("guided_tool_journal_result_invalid") from None

    def walk(value: Any):
        if isinstance(value, dict):
            yield value
            for child in value.values():
                yield from walk(child)
        elif isinstance(value, list):
            for child in value:
                yield from walk(child)

    actual_sources: list[dict[str, str]] = []
    for index, source in enumerate(expected_sources):
        query_call, read_call = relevant[index * 2:index * 2 + 2]
        if query_call["status"] != "completed" or query_call["error_code"] is not None or \
           read_call["status"] != "completed" or read_call["error_code"] is not None:
            raise ValueError("guided_tool_journal_call_not_completed")
        query_result = decode(query_call["result_json"])
        query_matches: list[dict[str, Any]] = []
        for node in walk(query_result):
            result_rows = node.get("results")
            if node.get("ok") is True and node.get("status") == "complete" and \
               isinstance(result_rows, list):
                query_matches.extend(row for row in result_rows if isinstance(row, dict) and
                                     row.get("conversation_message_id") == source["message_id"] and
                                     row.get("source") == "conversation-store")
        if len(query_matches) != 1:
            raise ValueError("guided_tool_journal_query_source_mismatch")
        read_args = query_matches[0].get("read_args")
        if not isinstance(read_args, dict) or not str(read_args.get("source_ref", "")).startswith(
            "conversation-source:v2:"):
            raise ValueError("guided_tool_journal_canonical_read_args_missing")
        try:
            recorded_args = json.loads(read_call["arguments_json"])
        except (ValueError, TypeError):
            raise ValueError("guided_tool_journal_read_args_invalid") from None
        if recorded_args != read_args:
            raise ValueError("guided_tool_journal_read_args_not_forwarded")

        read_result = decode(read_call["result_json"])
        read_matches = []
        for node in walk(read_result):
            message_id = node.get("conversation_message_id", node.get("read_message_id"))
            if node.get("ok") is True and node.get("status") == "complete" and \
               message_id == source["message_id"] and node.get("text") == source["text"]:
                read_matches.append(node)
        if len(read_matches) != 1:
            raise ValueError("guided_tool_journal_read_source_mismatch")
        expected = expected_evidence[index]
        actual_sources.append({
            "fixture_id": source["id"],
            "source_message_id": source["message_id"],
            "query_memory": "completed",
            "query_source": "conversation-store",
            "read_conversation_session": "completed",
            "read_message_id": source["message_id"],
            "read_text_sha256": hashlib.sha256(source["text"].encode("utf-8")).hexdigest(),
            "read_args_sha256": hashlib.sha256(json.dumps(
                read_args, sort_keys=True, separators=(",", ":"), ensure_ascii=False
            ).encode("utf-8")).hexdigest(),
        })
        if any(actual_sources[-1].get(key) != value for key, value in expected.items()):
            raise ValueError("guided_tool_journal_evidence_mismatch")

    return {
        "status": "observed",
        "basis": "installed_public_guided_turn_tool_journal",
        "tool_invocation_count": len(relevant),
        "tool_names_in_order": [row["tool_name"] for row in relevant],
        "canonical_reads_complete": True,
        "sources": actual_sources,
    }
