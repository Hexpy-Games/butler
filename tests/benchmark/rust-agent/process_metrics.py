"""Read-only process-tree accounting for the isolated migration benchmark.

This module never launches Butler, reads command arguments, or signals a PID.
The campaign supplies identities of its own freshly launched root processes.
RSS sums are proxies; CPU is observed lifetime usage with sampling limitations.
"""

from dataclasses import dataclass
import os
import re
import subprocess
import time


@dataclass(frozen=True)
class Identity:
    pid: int
    started: str

    def wire(self):
        return {"pid": self.pid, "started": self.started}


@dataclass(frozen=True)
class Process:
    identity: Identity
    ppid: int
    cpu_seconds: float
    rss_bytes: int
    state: str
    cpu_resolution_seconds: float = 0.01


@dataclass(frozen=True)
class Snapshot:
    started: float
    ended: float
    processes: dict[int, Process]


class SampleUnavailable(Exception):
    """Do not interpret failed collection as zero processes or zero memory."""


def cpu_seconds(value):
    """Parse ps [days-][hours:]minutes:seconds[.fraction]."""
    days, separator, rest = value.partition("-")
    if not separator:
        rest, days = days, "0"
    parts = rest.split(":")
    if len(parts) == 2:
        hours, minutes, seconds = "0", *parts
    elif len(parts) == 3:
        hours, minutes, seconds = parts
    else:
        raise ValueError("invalid ps CPU time")
    if not re.fullmatch(r"\d+(?:\.\d+)?", seconds):
        raise ValueError("invalid ps CPU seconds")
    if not all(part.isascii() and part.isdigit() for part in (days, hours, minutes)):
        raise ValueError("invalid ps CPU fields")
    return int(days) * 86400 + int(hours) * 3600 + int(minutes) * 60 + float(seconds)


def parse_ps(output):
    processes = {}
    for line in output.splitlines():
        fields = line.split()
        if not fields:
            continue
        # pid, ppid, weekday, month, day, HH:MM:SS, year, cputime, rss, state.
        if len(fields) != 10:
            raise ValueError("unexpected ps column count")
        pid, ppid = int(fields[0]), int(fields[1])
        rss_kib = int(fields[8])
        if pid <= 0 or ppid < 0 or rss_kib < 0 or pid in processes:
            raise ValueError("invalid or duplicate process row")
        identity = Identity(pid, " ".join(fields[2:7]))
        fractional = fields[7].partition(".")[2]
        resolution = 10 ** -len(fractional) if fractional else 1
        processes[pid] = Process(identity, ppid, cpu_seconds(fields[7]), rss_kib * 1024, fields[9], resolution)
    return processes


def collect_ps():
    started = time.monotonic()
    # No `command`, `args`, environment or executable-path fields are collected.
    try:
        result = subprocess.run(
            ["ps", "-axo", "pid=,ppid=,lstart=,time=,rss=,stat="],
            capture_output=True, text=True, check=True, timeout=5,
            env={**os.environ, "LC_ALL": "C", "TZ": "UTC"},
        )
        processes = parse_ps(result.stdout)
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        # Raw subprocess output is not part of benchmark evidence.
        raise SampleUnavailable(type(error).__name__) from error
    return Snapshot(started, time.monotonic(), processes)


class TreeAccounting:
    """Retain CPU high-water marks, never RSS, for observed exited children.

    Descendants already observed remain owned after reparenting. New descendants
    are admitted only through a currently present process with the same identity.
    A reused PID cannot inherit ownership from an earlier observation.
    """

    def __init__(self, roots):
        self.roots = tuple(roots)
        if not self.roots or len({root.pid for root in self.roots}) != len(self.roots):
            raise ValueError("provide distinct launched root identities")
        self.known = set(self.roots)
        self.cpu_high_water = {}
        self.previous_time = None
        self.previous_cpu = None
        self.previous_live = set()
        self.cumulative_departures = set()
        self.failed_collections = 0

    def record_unavailable(self):
        """Call after SampleUnavailable; retain counters and expose the next gap."""
        self.failed_collections += 1

    def sample(self, snapshot):
        if snapshot.ended < snapshot.started:
            raise ValueError("negative collection duration")
        if self.previous_time is not None and snapshot.ended <= self.previous_time:
            raise ValueError("samples must advance monotonically")
        live = {
            pid: process for pid, process in snapshot.processes.items()
            if process.identity in self.known
        }
        # Fixed point handles any ps row order and multilevel descendants.
        pending = dict(snapshot.processes)
        while True:
            admitted = [process for pid, process in pending.items()
                        if pid not in live and process.ppid in live]
            if not admitted:
                break
            for process in admitted:
                live[process.identity.pid] = process
                self.known.add(process.identity)
                pending.pop(process.identity.pid)
        identities = {process.identity for process in live.values()}
        departures = self.previous_live - identities
        self.cumulative_departures.update(departures)
        regressions = []
        for process in live.values():
            prior = self.cpu_high_water.get(process.identity, 0.0)
            if process.cpu_seconds < prior:
                regressions.append(process.identity.wire())
            self.cpu_high_water[process.identity] = max(prior, process.cpu_seconds)
        total_cpu = sum(self.cpu_high_water.values())
        interval = None if self.previous_time is None else snapshot.ended - self.previous_time
        utilization = None if interval is None else 100 * (total_cpu - self.previous_cpu) / interval
        resolution = max((process.cpu_resolution_seconds for process in live.values()), default=None)
        row = {
            "schema": "butler.isolated-process-sample.v1",
            "monotonic_seconds": snapshot.ended,
            "collection_seconds": snapshot.ended - snapshot.started,
            "interval_seconds": interval,
            "process_count": len(live),
            "rss_sum_proxy_bytes": sum(process.rss_bytes for process in live.values()),
            "observed_cpu_seconds": total_cpu,
            "cpu_percent_one_core_sampled": utilization,
            "failed_collections_since_prior_sample": self.failed_collections,
            "cpu_interval_includes_collection_failure": self.failed_collections > 0,
            "cpu_counter_regressions": regressions,
            "departed_since_last_sample": sorted((item.wire() for item in departures), key=lambda item: (item["pid"], item["started"])),
            "root_identities_present": [root.wire() for root in self.roots if root in identities],
            "processes": [
                {**process.identity.wire(), "ppid": process.ppid,
                 "cpu_seconds": process.cpu_seconds, "rss_bytes": process.rss_bytes,
                 "cpu_resolution_seconds": process.cpu_resolution_seconds, "state": process.state}
                for _, process in sorted(live.items())
            ],
            "coverage": {
                "identity_start_precision_seconds": 1,
                "identity_timezone": "UTC",
                "same_second_pid_reuse_indistinguishable": True,
                "coarsest_live_cpu_resolution_seconds": resolution,
                "cpu_sample_quantization_may_dominate_interval":
                    interval is not None and resolution is not None and resolution >= interval,
                "unseen_short_lived_descendants_possible": True,
                "departed_cpu_final_value_unavailable": len(self.cumulative_departures),
                "cpu_includes_observed_lifetime_before_first_sample": True,
                "physical_footprint": "not_collected",
            },
        }
        self.previous_time, self.previous_cpu = snapshot.ended, total_cpu
        self.previous_live = identities
        self.failed_collections = 0
        return row
