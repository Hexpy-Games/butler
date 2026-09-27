"""Immutable artifact inventory and strict ownership for future frozen launches."""

from __future__ import annotations

import hashlib
import os
from pathlib import Path
import signal
import subprocess
import time
from typing import Any

from process_metrics import Identity, SampleUnavailable, collect_ps


def artifact_manifest(root: Path) -> dict[str, dict[str, Any]]:
    root = root.resolve(strict=True)
    if not root.is_dir():
        raise ValueError("installation must be a directory")
    result: dict[str, dict[str, Any]] = {}
    for path in sorted(root.rglob("*")):
        relative = str(path.relative_to(root))
        stat = path.lstat()
        if path.is_symlink():
            target = path.resolve(strict=True)
            if not target.is_relative_to(root):
                raise ValueError("installation symlink leaves immutable root")
            result[relative] = {"type": "symlink", "target": os.readlink(path)}
        elif path.is_file():
            digest = hashlib.sha256()
            with path.open("rb") as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(block)
            result[relative] = {
                "type": "file", "sha256": digest.hexdigest(),
                "size": stat.st_size, "mode": stat.st_mode & 0o777,
            }
        elif path.is_dir():
            result[relative] = {"type": "directory", "mode": stat.st_mode & 0o777}
        else:
            raise ValueError("installation contains unsupported file type")
    return result


def verify_artifact_unchanged(root: Path, before: dict[str, dict[str, Any]]) -> None:
    if artifact_manifest(root) != before:
        raise RuntimeError("immutable_installation_changed")


class OwnedLaunch:
    def __init__(self, commands: list[list[str]], cwd: Path, env: dict[str, str], log_directory: Path):
        if not commands or any(not command or not Path(command[0]).is_absolute() for command in commands):
            raise ValueError("every product command needs an absolute executable")
        self.commands = commands
        self.cwd = cwd
        self.env = env
        self.log_directory = log_directory
        self.processes: list[subprocess.Popen[bytes]] = []
        self.roots: list[Identity] = []
        self._logs: list[Any] = []

    def start(self) -> tuple[Identity, ...]:
        self.log_directory.mkdir(mode=0o700, parents=True, exist_ok=False)
        try:
            for index, command in enumerate(self.commands):
                descriptor = (self.log_directory / f"backend-{index}.log").open("xb")
                os.fchmod(descriptor.fileno(), 0o600)
                self._logs.append(descriptor)
                process = subprocess.Popen(command, cwd=self.cwd, env=self.env,
                                           stdin=subprocess.DEVNULL, stdout=descriptor,
                                           stderr=subprocess.STDOUT, start_new_session=True)
                self.processes.append(process)
                snapshot = collect_ps()
                observed = snapshot.processes.get(process.pid)
                if observed is None:
                    raise RuntimeError("new_backend_root_identity_unavailable")
                self.roots.append(observed.identity)
            return tuple(self.roots)
        except BaseException:
            identified = {identity.pid for identity in self.roots}
            for process in self.processes:
                if process.pid in identified or process.poll() is not None:
                    continue
                # This is the exact unreaped Popen child we just created, not a
                # name/PID search result. Keep ownership even if ps failed.
                try:
                    process.terminate()
                except ProcessLookupError:
                    pass
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=2)
            self.shutdown(set(self.roots))
            raise

    def shutdown(self, observed_owned: set[Identity], deadline_s: float = 15) -> dict[str, Any]:
        owned = observed_owned | set(self.roots)
        forced = False
        observation_unavailable = False
        residual: set[Identity] = set()
        try:
            for identity in self.roots:
                _signal_if_same_identity(identity, signal.SIGTERM)
            limit = time.monotonic() + deadline_s
            while owned and time.monotonic() < limit:
                if not _live_owned(owned):
                    break
                time.sleep(0.1)
            residual = _live_owned(owned) if owned else set()
            if residual:
                forced = True
                for identity in residual:
                    _signal_if_same_identity(identity, signal.SIGKILL)
        except SampleUnavailable:
            observation_unavailable = True
            forced = True
            for process in self.processes:
                if process.poll() is None:
                    try:
                        process.terminate()
                    except ProcessLookupError:
                        pass
        for process in self.processes:
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=2)
                forced = True
        for descriptor in self._logs:
            descriptor.close()
        try:
            remaining = len(_live_owned(owned)) if owned else 0
        except SampleUnavailable:
            remaining = None
            observation_unavailable = True
        return {
            "forced_termination": forced,
            "residual_owned_process_count": remaining,
            "observed_owned_process_count": len(owned),
            "ownership_observation_unavailable": observation_unavailable,
        }


def _live_owned(identities: set[Identity]) -> set[Identity]:
    snapshot = collect_ps()
    return {identity for identity in identities
            if (process := snapshot.processes.get(identity.pid)) is not None
            and process.identity == identity and not process.state.startswith("Z")}


def _signal_if_same_identity(identity: Identity, sig: signal.Signals) -> None:
    if identity not in _live_owned({identity}):
        return
    try:
        os.kill(identity.pid, sig)
    except ProcessLookupError:
        pass
