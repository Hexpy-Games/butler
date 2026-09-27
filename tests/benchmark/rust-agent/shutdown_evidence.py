"""Read-only listener check for the isolated loopback benchmark port."""

from __future__ import annotations

import subprocess
from typing import Any

from process_metrics import Identity, SampleUnavailable, collect_ps


LSOF = "/usr/sbin/lsof"


def inspect_listener_residue(port: int, owned: set[Identity]) -> dict[str, Any]:
    if not isinstance(port, int) or not 1 <= port <= 65535:
        return {"status": "unavailable", "reason": "invalid_loopback_port"}
    try:
        result = subprocess.run(
            [LSOF, "-nP", "-a", f"-iTCP:{port}", "-sTCP:LISTEN", "-Fp"],
            capture_output=True, text=True, timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        return {"status": "unavailable", "reason": "listener_observer_unavailable"}
    if result.stderr or result.returncode not in {0, 1}:
        return {"status": "unavailable", "reason": "listener_observer_unavailable"}
    try:
        pids = sorted({int(line[1:]) for line in result.stdout.splitlines()
                       if line.startswith("p") and line[1:].isdigit()})
    except ValueError:
        return {"status": "unavailable", "reason": "listener_observation_invalid"}
    if result.returncode == 0 and not pids:
        return {"status": "unavailable", "reason": "listener_observation_invalid"}
    if result.returncode == 1 and pids:
        return {"status": "unavailable", "reason": "listener_observation_invalid"}

    try:
        current = collect_ps().processes
    except (SampleUnavailable, ValueError):
        return {
            "status": "observed",
            "listener_count": len(pids),
            "owned_listener_count": None,
            "unowned_listener_count": None,
            "ownership_status": "unavailable",
            "reason": "listener_owner_identity_unavailable",
        }
    identities = {pid: current[pid].identity for pid in pids if pid in current}
    owned_pids = {pid for pid, identity in identities.items() if identity in owned}
    owner_observed = len(identities) == len(pids)
    return {
        "status": "observed",
        "listener_count": len(pids),
        "owned_listener_count": len(owned_pids) if owner_observed else None,
        "unowned_listener_count": len(pids) - len(owned_pids) if owner_observed else None,
        "ownership_status": "observed" if owner_observed else "unavailable",
        "listener_residue": bool(pids),
    }
