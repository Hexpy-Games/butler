"""Frozen source and ten-case contract; no product process is started."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any


PATH = Path(__file__).with_name("workload.json")
EXPECTED_OUTPUT_HASHES = (
    "ce962eb9d75c02d320f36c6e0141119f7a60d443910a081985c9d565b2079783",
    "ab03bdfcd744dfaa7dbc4e143a7ae45e1c2b66a7f223691ac94e2b9fd2add420",
    "e6b4fa41e0426f821c496e86caff2ac14af7a2be7128982d71dd5285861ab0e5",
    "7b2aed2a758bcd60e47d00af6309e86f2a7222ee762053628a4b77525ac11081",
)


def load_workload() -> dict[str, Any]:
    workload = json.loads(PATH.read_text(encoding="utf-8"))
    sources = workload["sources"]
    cases = workload["cases"]
    if workload["schema"] != "butler.rust-benchmark.workload.v1":
        raise ValueError("workload schema changed")
    if len(sources) != 7 or len(cases) != 10 or [case["id"] for case in cases] != list(range(1, 11)):
        raise ValueError("workload cardinality changed")
    if len({source["session_id"] for source in sources}) != 7 or len({source["message_id"] for source in sources}) != 7:
        raise ValueError("source IDs are not unique")
    if not all(source["at"].startswith("2026-") for source in sources):
        raise ValueError("source timestamp changed")
    source_ids = {source["id"] for source in sources}
    if any(not set(case["source_ids"]).issubset(source_ids) for case in cases):
        raise ValueError("unknown source reference")
    outputs = [case["output"] for case in cases if "output" in case]
    if len(outputs) != 4:
        raise ValueError("file workload changed")
    for output, expected in zip(outputs, EXPECTED_OUTPUT_HASHES, strict=True):
        actual = hashlib.sha256(output["text"].encode("utf-8")).hexdigest()
        if actual != expected or output["sha256"] != expected:
            raise ValueError("output bytes/hash changed")
    if workload["workspace_seed"] != {"path": "inputs/package-name.txt", "text": "Orchid\n"}:
        raise ValueError("workspace seed changed")
    return workload


def full_prompt(workload: dict[str, Any], case: dict[str, Any]) -> str:
    return workload["source_prefix"] + case["prompt"]
