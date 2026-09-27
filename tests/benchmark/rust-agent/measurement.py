"""External macOS process observations for owned benchmark backend roots."""

from __future__ import annotations

import re
import subprocess
import threading
import time
from typing import Any

from process_metrics import Identity, SampleUnavailable, TreeAccounting, collect_ps


class ProcessMeter:
    def __init__(self, roots: tuple[Identity, ...], period_s: float = 0.1):
        self.accounting = TreeAccounting(roots)
        self.period_s = period_s
        self.samples: list[dict[str, Any]] = []
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread is not None:
            raise RuntimeError("meter already started")
        self._thread = threading.Thread(target=self._loop, name="rust-benchmark-process-meter", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=10)
            if self._thread.is_alive():
                raise RuntimeError("process meter did not stop")

    def _loop(self) -> None:
        next_at = time.monotonic()
        while not self._stop.is_set():
            try:
                snapshot = collect_ps()
                with self._lock:
                    self.samples.append(self.accounting.sample(snapshot))
            except (SampleUnavailable, ValueError) as error:
                with self._lock:
                    self.accounting.record_unavailable()
                    self.samples.append({
                        "monotonic_seconds": time.monotonic(),
                        "unavailable": type(error).__name__,
                    })
            next_at += self.period_s
            self._stop.wait(max(0, next_at - time.monotonic()))

    def latest(self) -> dict[str, Any] | None:
        with self._lock:
            if not self.samples or "processes" not in self.samples[-1]:
                return None
            if time.monotonic() - self.samples[-1]["monotonic_seconds"] > max(1.0, self.period_s * 3):
                return None
            return self.samples[-1].copy()

    def slice(self, start_s: float, end_s: float) -> list[dict[str, Any]]:
        with self._lock:
            return [row.copy() for row in self.samples
                    if start_s <= row["monotonic_seconds"] <= end_s]

    def physical_checkpoint(self) -> dict[str, Any]:
        """Collect checkpoint footprint after a terminal timestamp, never as peak."""
        sample = self.latest()
        if sample is None:
            return {"status": "unavailable", "reason": "no_fresh_process_sample"}
        if not sample["processes"]:
            return {"status": "unavailable", "reason": "no_live_owned_process"}
        try:
            before = collect_ps()
        except SampleUnavailable:
            return {"status": "unavailable", "reason": "identity_snapshot_unavailable"}
        values = []
        for observed in sample["processes"]:
            pid = observed["pid"]
            identity = Identity(pid, observed["started"])
            if before.processes.get(pid) is None or before.processes[pid].identity != identity:
                values.append({"pid": pid, "status": "unavailable", "reason": "identity_departed"})
                continue
            value = _footprint_bytes(pid)
            try:
                after = collect_ps()
            except SampleUnavailable:
                values.append({"pid": pid, "status": "unavailable", "reason": "identity_snapshot_unavailable"})
                continue
            if after.processes.get(pid) is None or after.processes[pid].identity != identity:
                values.append({"pid": pid, "status": "unavailable", "reason": "identity_changed"})
            elif value is None:
                values.append({"pid": pid, "status": "unavailable", "reason": "physical_footprint_unavailable"})
            else:
                values.append({"pid": pid, "started": identity.started,
                               "status": "observed", "physical_footprint_bytes": value})
        complete = all(row["status"] == "observed" for row in values)
        return {
            "status": "observed" if complete else "unavailable",
            "monotonic_seconds": time.monotonic(),
            "per_process": values,
            "physical_footprint_sum_proxy_bytes":
                sum(row["physical_footprint_bytes"] for row in values) if complete else None,
            "tree_peak_physical_footprint": "unavailable",
        }


def _footprint_bytes(pid: int) -> int | None:
    try:
        result = subprocess.run(
            ["/usr/bin/footprint", "--pid", str(pid), "--format", "bytes", "--noCategories"],
            capture_output=True, text=True, timeout=15, check=True,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    match = re.search(r"phys_footprint:\s*([\d.]+)\s*(?:bytes?|B)", result.stdout, re.I)
    if match is None:
        return None
    value = float(match.group(1))
    return int(value) if value >= 0 else None


def summarize_samples(rows: list[dict[str, Any]]) -> dict[str, Any]:
    valid = [row for row in rows if "processes" in row]
    ordinary_cpu = [row["cpu_percent_one_core_sampled"] for row in valid
                    if row["cpu_percent_one_core_sampled"] is not None
                    and not row["cpu_interval_includes_collection_failure"]]
    return {
        "sample_count": len(valid),
        "unavailable_sample_count": len(rows) - len(valid),
        "rss_peak_sum_proxy_bytes": max((row["rss_sum_proxy_bytes"] for row in valid), default=None),
        "rss_last_sum_proxy_bytes": valid[-1]["rss_sum_proxy_bytes"] if valid else None,
        "process_peak_count": max((row["process_count"] for row in valid), default=None),
        "observed_cpu_seconds_delta":
            valid[-1]["observed_cpu_seconds"] - valid[0]["observed_cpu_seconds"]
            if len(valid) >= 2 else None,
        "cpu_peak_percent_one_core_sampled": max(ordinary_cpu, default=None),
        "cpu_gap_intervals": sum(bool(row["cpu_interval_includes_collection_failure"]) for row in valid),
        "mean_actual_interval_seconds":
            sum(row["interval_seconds"] for row in valid if row["interval_seconds"] is not None) /
            sum(row["interval_seconds"] is not None for row in valid)
            if any(row["interval_seconds"] is not None for row in valid) else None,
    }
