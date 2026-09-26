"""Descriptive paired comparison over redacted, frozen-arm evidence."""

from __future__ import annotations

from statistics import median
from typing import Any


ARM_ORDER = (("legacy", "candidate"), ("candidate", "legacy"), ("legacy", "candidate"))


def interval_union_ns(intervals: list[tuple[int, int]]) -> int:
    normalized = sorted((start, end) for start, end in intervals if end >= start)
    if not normalized:
        return 0
    total = 0
    left, right = normalized[0]
    for start, end in normalized[1:]:
        if start > right:
            total += right - left
            left, right = start, end
        else:
            right = max(right, end)
    return total + right - left


def local_residual_ns(wall_ns: int | None, provider: list[tuple[int, int]] | None,
                      tools: list[tuple[int, int]] | None) -> int | None:
    if wall_ns is None or provider is None or tools is None:
        return None
    return max(0, wall_ns - interval_union_ns(provider + tools))


def paired_report(pairs: list[dict[str, Any]], metric: str) -> dict[str, Any]:
    if len(pairs) != 3:
        raise ValueError("three frozen paired trials required")
    observations = []
    valid_differences = []
    for index, (pair, order) in enumerate(zip(pairs, ARM_ORDER, strict=True), start=1):
        if tuple(pair.get("order", ())) != order:
            raise ValueError("paired arm order changed")
        legacy = pair.get("legacy", {})
        candidate = pair.get("candidate", {})
        comparable = legacy.get("accuracy_passed") is True and candidate.get("accuracy_passed") is True
        left, right = legacy.get(metric), candidate.get(metric)
        comparable = comparable and isinstance(left, (int, float)) and isinstance(right, (int, float))
        percent = (100 * (right - left) / left) if comparable and left != 0 else None
        if comparable:
            valid_differences.append(right - left)
        observations.append({
            "pair": index,
            "order": order,
            "legacy": left,
            "candidate": right,
            "comparable": comparable,
            "candidate_minus_legacy": right - left if comparable else None,
            "percent_difference": percent,
            "failure_codes": {
                "legacy": legacy.get("failure_codes", []),
                "candidate": candidate.get("failure_codes", []),
            },
        })
    return {
        "metric": metric,
        "pairs": observations,
        "valid_pair_count": len(valid_differences),
        "paired_difference_median": median(valid_differences) if valid_differences else None,
        "paired_difference_range":
            [min(valid_differences), max(valid_differences)] if valid_differences else None,
        "interpretation": "descriptive; provider and network variation remain",
    }
