"""Frozen-artifact campaign runner. Default invocation validates only; never launches.

An actual provider campaign additionally requires --execute and a root-reviewed
readiness receipt for both artifacts. Do not use during product development.
"""

from __future__ import annotations

import argparse
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import platform
import secrets
import socket
from statistics import median
import subprocess
import sys
import tempfile
import time
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app_protocol import AppClient, AppProtocolError
from correctness import assess_case, workspace_hashes
from distribution_evidence import BUN_PATH, bun_executable_evidence, inspect_distribution
from launch import OwnedLaunch, artifact_manifest, verify_artifact_unchanged
from measurement import ProcessMeter, summarize_samples
from process_metrics import Identity, collect_ps
from readiness import digest as readiness_digest, validate_readiness_receipt
from shutdown_evidence import inspect_listener_residue
from summary import ARM_ORDER, local_residual_ns, paired_report
from tool_evidence import inspect_run_command_hash, inspect_tool_journal
from turn_observer import observe_delegated_result, observe_turn
from workload import full_prompt, load_workload


SOURCE = Path(__file__).resolve().parents[2]  # tests/
REPO = SOURCE.parent
PRIVATE_MODE = 0o600
PRIVATE_DIRECTORY_MODE = 0o700
PRODUCTION_DATA = Path.home() / ".butler"
FROZEN_HARNESS_FILES = (
    "app_protocol.py", "correctness.py", "launch.py", "run_campaign.py",
    "tool_evidence.py", "turn_observer.py", "workload.json",
)


def _private_file(path: Path) -> bytes:
    stat = path.lstat()
    if not path.is_file() or path.is_symlink() or stat.st_mode & 0o077:
        raise ValueError("required input file must be private and regular")
    return path.read_bytes()


def _private_input_path(value: Any, label: str) -> Path:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{label} path missing")
    try:
        path = Path(value).resolve(strict=True)
    except OSError as error:
        raise ValueError(f"{label} path unavailable") from error
    production_roots = [PRODUCTION_DATA]
    configured_data = os.environ.get("BUTLER_DATA")
    if configured_data:
        production_roots.append(Path(configured_data).expanduser())
    home = os.environ.get("HOME")
    if home:
        production_roots.append(Path(home).expanduser() / ".butler")
    production_roots = [root.resolve(strict=False) for root in production_roots]
    if path == REPO or path.is_relative_to(REPO) or any(
        path == root or path.is_relative_to(root) for root in production_roots
    ):
        raise ValueError(f"{label} must be separate from source and production data")
    return path


def _provider_input_mode(contract: dict[str, Any]) -> tuple[str, Path]:
    has_oauth_file = "provider_codex_oauth_file" in contract
    has_credential_file = "provider_credential_file" in contract
    env_presence = ["provider_env_file" in contract.get(arm, {})
                    for arm in ("legacy", "candidate")]
    if has_oauth_file:
        if has_credential_file or any(env_presence) or "provider_credential_id" in contract:
            raise ValueError("Codex OAuth input cannot be combined with another provider input")
        return "codex_oauth", _private_input_path(
            contract["provider_codex_oauth_file"], "Codex OAuth profile")
    if has_credential_file:
        if any(env_presence):
            raise ValueError("provider credential file and provider environment input are mutually exclusive")
        if "provider_credential_id" in contract and not isinstance(contract["provider_credential_id"], str):
            raise ValueError("provider credential id invalid")
        return "stored_credential", _private_input_path(
            contract["provider_credential_file"], "provider credential file")
    if "provider_credential_id" in contract:
        raise ValueError("provider credential id requires provider credential file")
    if not all(env_presence):
        raise ValueError("same provider input must be specified for both arms")
    legacy_path = contract["legacy"]["provider_env_file"]
    candidate_path = contract["candidate"]["provider_env_file"]
    if not isinstance(legacy_path, str) or legacy_path != candidate_path:
        raise ValueError("provider environment input must be the same private file for both arms")
    return "environment", _private_input_path(legacy_path, "provider environment input")


def _load_provider_input(contract: dict[str, Any]) -> dict[str, Any]:
    mode, path = _provider_input_mode(contract)
    try:
        value = json.loads(_private_file(path))
    except (OSError, ValueError, json.JSONDecodeError) as error:
        raise ValueError("provider input is not valid private JSON") from error
    if mode == "codex_oauth":
        if contract.get("model") != "openai/gpt-6-sol" or not isinstance(value, dict) or \
           value.get("provider") != "openai-codex" or value.get("type") != "oauth" or \
           not all(isinstance(value.get(field), str) and value[field]
                   for field in ("accessToken", "refreshToken", "accountId")):
            raise ValueError("frozen Codex OAuth profile or selected model invalid")
        return {"mode": mode, "profile": value}
    if mode == "environment":
        if not isinstance(value, dict) or not value or not all(
            isinstance(key, str) and isinstance(item, str) for key, item in value.items()
        ):
            raise ValueError("provider environment invalid")
        boundary_names = {"HOME", "PATH", "TMPDIR", "TZ", "LANG", "LC_ALL", "SYSTEMROOT",
                          "EMBED_SOCKET"}
        if any(key in boundary_names or key.startswith(("BUTLER_", "HF_", "HUGGINGFACE_",
                                                        "TRANSFORMERS_", "XDG_"))
               for key in value):
            raise ValueError("provider environment cannot override isolated runtime boundaries")
        return {"mode": mode, "environment": value}

    model = contract.get("model")
    if not isinstance(model, str) or not model.startswith("zai/") or \
       not model[len("zai/"):] or "/" in model[len("zai/"):]:
        raise ValueError("stored Z.AI credential input requires one Z.AI model reference")
    if not isinstance(value, dict) or set(value) != {"credentials"} or \
       not isinstance(value.get("credentials"), list):
        raise ValueError("provider credential file schema invalid")
    records = value["credentials"]
    requested_id = contract.get("provider_credential_id")
    if isinstance(requested_id, str):
        requested_id = requested_id.strip()
        if not requested_id:
            raise ValueError("provider credential id invalid")
        selected = [record for record in records
                    if isinstance(record, dict) and record.get("id") == requested_id]
    else:
        selected = [record for record in records
                    if isinstance(record, dict) and record.get("provider_id") == "zai"]
        if len(selected) != 1:
            raise ValueError("one Z.AI credential or an explicit provider credential id is required")
    if len(selected) != 1:
        raise ValueError("selected provider credential is missing or ambiguous")
    record = selected[0]
    credential_id = record.get("id")
    secret = record.get("secret")
    if record.get("provider_id") != "zai" or record.get("auth_type") != "api_key" or \
       not isinstance(credential_id, str) or not credential_id.strip() or \
       credential_id != credential_id.strip() or \
       not isinstance(secret, str) or not secret.strip() or secret != secret.strip():
        raise ValueError("selected credential must be a stored Z.AI API key")
    # Project only the provider credential fields consumed by TypeScript and Rust.
    credential = {"id": credential_id, "provider_id": "zai",
                  "auth_type": "api_key", "secret": secret}
    return {"mode": mode, "credential": credential}


def _write_provider_credential(data_root: Path, credential: dict[str, str]) -> Path:
    auth_dir = data_root / "auth"
    if auth_dir.is_symlink():
        raise ValueError("isolated provider auth directory must not be a symbolic link")
    auth_dir.mkdir(mode=PRIVATE_DIRECTORY_MODE, parents=True, exist_ok=True)
    os.chmod(auth_dir, PRIVATE_DIRECTORY_MODE)
    path = auth_dir / "model-provider-credentials.json"
    _new_private_file(path, json.dumps({"credentials": [credential]}).encode())
    return path


def _write_codex_oauth_profile(data_root: Path, profile: dict[str, Any]) -> Path:
    auth_dir = data_root / "auth"
    if auth_dir.is_symlink():
        raise ValueError("isolated provider auth directory must not be a symbolic link")
    auth_dir.mkdir(mode=PRIVATE_DIRECTORY_MODE, parents=True, exist_ok=True)
    os.chmod(auth_dir, PRIVATE_DIRECTORY_MODE)
    path = auth_dir / "openai-codex.json"
    _new_private_file(path, json.dumps(profile).encode())
    return path


def _stored_model_registration(model: str, credential: dict[str, str]) -> dict[str, Any]:
    provider, model_id = model.split("/", 1)
    if provider != "zai" or not model_id:
        raise ValueError("stored Z.AI credential input requires one Z.AI model reference")
    return {"provider_id": provider, "model_id": model_id,
            "auth_type": "api_key", "credential_id": credential["id"]}


def _digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _launch_spec_sha256(commands: list[list[str]]) -> str:
    return _digest({"commands": commands})


def _fixture_procedure_sha256() -> str:
    names = ("run_campaign.py", "readiness.py", "installed_canonical_readiness.py",
             "seed_canonical_fixture.ts", "workload.json")
    files = Path(__file__).parent
    return _digest({name: hashlib.sha256((files / name).read_bytes()).hexdigest()
                    for name in names})


def _active_generation_present(data_root: Path) -> bool:
    path = data_root
    for index, part in enumerate(("cognition", "memory", "active-generation.json")):
        path = path / part
        try:
            path.lstat()
        except FileNotFoundError:
            return False
        if path.is_symlink():
            raise ValueError("isolated active memory descriptor path must not contain symbolic links")
        if index < 2 and not path.is_dir():
            raise ValueError("isolated active memory descriptor parent is not a directory")
    return True


def _embedding_asset_snapshot(data_root: Path) -> dict[str, Any]:
    root = data_root
    for index, part in enumerate(("cache", "models", "Xenova", "bge-m3")):
        root = root / part
        try:
            root.lstat()
        except FileNotFoundError:
            return {"status": "observed", "root_present": False, "entry_count": 0,
                    "file_count": 0, "sha256": _digest([])}
        if root.is_symlink():
            raise ValueError("isolated embedding asset cache path contains a symbolic link")
        if index < 3 and not root.is_dir():
            raise ValueError("isolated embedding asset cache parent is not a directory")
    if not root.is_dir():
        raise ValueError("isolated embedding asset cache is not a directory")
    entries: list[dict[str, Any]] = []
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise ValueError("isolated embedding asset cache contains a symbolic link")
        relative = path.relative_to(root).as_posix()
        if path.is_dir():
            entries.append({"type": "directory", "path": relative})
        elif path.is_file():
            digest = hashlib.sha256()
            with path.open("rb") as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(block)
            entries.append({"type": "file", "path": relative,
                            "size": path.stat().st_size, "sha256": digest.hexdigest()})
        else:
            raise ValueError("isolated embedding asset cache contains an unsupported entry")
    return {"status": "observed", "root_present": True, "entry_count": len(entries),
            "file_count": sum(entry["type"] == "file" for entry in entries),
            "sha256": _digest(entries)}


def _suppress_daily_memory_jobs(data_root: Path, timezone: str) -> str:
    try:
        day = datetime.now(ZoneInfo(timezone)).date().isoformat()
    except (ValueError, ZoneInfoNotFoundError) as error:
        raise ValueError("benchmark timezone is not available") from error
    state_root = data_root / "state" / "scheduler"
    state_root.mkdir(mode=PRIVATE_DIRECTORY_MODE, parents=True, exist_ok=True)
    for job in ("session-sync", "consolidation-cycle"):
        path = state_root / f"{job}.json"
        if path.is_symlink() or (path.exists() and not path.is_file()):
            raise ValueError("isolated scheduler state must be a regular file")
        with path.open("wb") as stream:
            os.fchmod(stream.fileno(), PRIVATE_MODE)
            stream.write(json.dumps({"lastRunDate": day,
                                     "status": "benchmark_suppressed"}).encode())
    return day


def _validate_contract(contract: dict[str, Any]) -> dict[str, Any]:
    if contract.get("schema") != "butler.rust-benchmark.campaign.v1":
        raise ValueError("campaign schema invalid")
    if contract.get("baseline_revision") != "b484052e5683109d0a2491566024a9110090fbb2":
        raise ValueError("legacy baseline revision changed")
    bun = bun_executable_evidence()
    if bun.get("status") != "observed":
        raise ValueError("canonical baseline Bun executable unavailable")
    if contract.get("baseline_bun_executable_sha256") != bun["sha256"]:
        raise ValueError("canonical baseline Bun executable SHA differs")
    if contract.get("architecture") != "macos-arm64":
        raise ValueError("only macOS arm64 campaign is specified")
    if sys.platform != "darwin" or os.uname().machine != "arm64":
        raise ValueError("campaign host is not macOS arm64")
    model = contract.get("model")
    reasoning = contract.get("reasoning_effort")
    if not isinstance(model, str) or "/" not in model or not isinstance(reasoning, str):
        raise ValueError("model and reasoning must be frozen")
    if not isinstance(contract.get("locale"), str) or not isinstance(contract.get("timezone"), str) or \
       not contract["locale"] or not contract["timezone"]:
        raise ValueError("locale and timezone must be frozen")
    if not all(isinstance(contract.get(key), str) and contract[key]
               for key in ("candidate_revision", "legacy_toolchain", "candidate_toolchain", "candidate_features")):
        raise ValueError("revision/toolchain/features metadata missing")
    receipt_path = _private_input_path(contract.get("readiness_receipt_file"),
                                      "readiness receipt")
    receipt = json.loads(_private_file(receipt_path))
    if not isinstance(receipt, dict):
        raise ValueError("readiness receipt schema invalid")
    if receipt.get("schema") == "butler.rust-benchmark.delegation-fix-readiness.v1":
        actual_harness = {
            name: hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()
            for name in FROZEN_HARNESS_FILES
        }
        if contract.get("harness_files_sha256") != actual_harness:
            raise ValueError("new campaign harness changed after freeze")
    installation = {"_baseline_bun_executable_sha256": bun["sha256"]}
    arm_facts: dict[str, dict[str, str]] = {}
    for arm in ("legacy", "candidate"):
        spec = contract[arm]
        root = Path(spec["installation_root"]).resolve(strict=True)
        if root == REPO or root.is_relative_to(REPO):
            raise ValueError("campaign installation cannot be mutable source checkout")
        commands = spec.get("commands")
        if not commands or not all(isinstance(command, list) and command and
                                   isinstance(command[0], str) and
                                   Path(command[0].replace("{installation}", str(root))).is_absolute()
                                   for command in commands):
            raise ValueError("explicit absolute backend commands required")
        if arm == "legacy" and len(commands) != 2:
            raise ValueError("legacy gateway plus executor required")
        if arm == "candidate" and len(commands) < 1:
            raise ValueError("native backend command missing")
        manifest = artifact_manifest(root)
        observed_hash = _digest(manifest)
        if observed_hash != spec.get("frozen_manifest_sha256"):
            raise ValueError("frozen installation manifest differs")
        launch_spec_hash = _launch_spec_sha256(commands)
        distribution = inspect_distribution(root, commands)
        installation[arm] = {"root": root, "manifest": manifest,
                              "manifest_sha256": observed_hash,
                              "launch_spec_sha256": launch_spec_hash,
                              "distribution": distribution}
        arm_facts[arm] = {"manifest_sha256": observed_hash,
                          "launch_spec_sha256": launch_spec_hash}
    expected_legacy_revision = contract["baseline_revision"]
    catalog_receipt = receipt
    if receipt.get("schema") == "butler.rust-benchmark.delegation-fix-readiness.v1":
        prior_path = _private_input_path(receipt.get("prior_catalog_readiness_receipt_file"),
                                         "prior catalog readiness receipt")
        prior_raw = _private_file(prior_path)
        if hashlib.sha256(prior_raw).hexdigest() != receipt.get(
            "prior_catalog_readiness_receipt_sha256"
        ):
            raise ValueError("prior catalog readiness receipt changed")
        catalog_receipt = json.loads(prior_raw)
    if catalog_receipt.get("schema") == "butler.rust-benchmark.catalog-only-readiness.v1":
        catalog_sha = catalog_receipt.get("catalog_patch_provenance", {}).get("legacy_catalog_sha256")
        expected_legacy_revision += f"+catalog:{catalog_sha}"
    if contract["legacy"].get("installed_revision") != expected_legacy_revision:
        raise ValueError("installed legacy artifact revision differs")
    if contract["candidate"].get("installed_revision") != contract["candidate_revision"]:
        raise ValueError("installed native artifact revision differs")
    if receipt.get("schema") == "butler.rust-benchmark.delegation-fix-readiness.v1":
        _validate_delegation_fix_readiness(receipt, catalog_receipt, model, reasoning,
                                           arm_facts, installation, load_workload())
    elif receipt.get("schema") == "butler.rust-benchmark.catalog-only-readiness.v1":
        _validate_catalog_only_readiness(receipt, model, reasoning, arm_facts,
                                         installation, load_workload())
    else:
        validate_readiness_receipt(
            receipt,
            model=model,
            reasoning_effort=reasoning,
            workload=load_workload(),
            arm_facts=arm_facts,
            fixture_procedure_sha256=_fixture_procedure_sha256(),
        )
    for arm in ("legacy", "candidate"):
        installation[arm]["canonical_read_evidence_sha256"] = \
            receipt["arms"][arm]["canonical_read_evidence_sha256"]
    return installation


def _validate_delegation_fix_readiness(receipt: dict[str, Any], prior: dict[str, Any],
                                       model: str, reasoning: str,
                                       arm_facts: dict[str, dict[str, str]],
                                       installation: dict[str, Any],
                                       workload: dict[str, Any]) -> None:
    """Bind the new native package to prior catalog proof and one real child run."""
    if prior.get("schema") != "butler.rust-benchmark.catalog-only-readiness.v1" or \
       receipt.get("model") != model or receipt.get("reasoning_effort") != reasoning or \
       receipt.get("fallback_settings") != {"enabled": False, "models": []} or \
       receipt.get("fixture_procedure_sha256") != _fixture_procedure_sha256():
        raise ValueError("delegation-fix readiness selection differs")
    old_root = Path(receipt.get("prior_candidate_installation_root", "")).resolve(strict=True)
    if not old_root.is_dir() or old_root == REPO or old_root.is_relative_to(REPO) or \
       old_root == PRODUCTION_DATA or old_root.is_relative_to(PRODUCTION_DATA):
        raise ValueError("prior candidate installation invalid")
    old_manifest = artifact_manifest(old_root)
    old_facts = {"legacy": arm_facts["legacy"], "candidate": {
        "manifest_sha256": _digest(old_manifest),
        "launch_spec_sha256": installation["candidate"]["launch_spec_sha256"],
    }}
    _validate_catalog_only_readiness(
        prior, model, reasoning, old_facts,
        {"legacy": installation["legacy"], "candidate": {"manifest": old_manifest}}, workload,
        expected_fixture_procedure_sha256=prior["fixture_procedure_sha256"],
    )
    if receipt.get("candidate_binary_sha256") != installation["candidate"]["manifest"].get(
        "butler-agent", {}
    ).get("sha256") or receipt.get("candidate_manifest_sha256") != arm_facts["candidate"][
        "manifest_sha256"
    ] or receipt.get("candidate_launch_spec_sha256") != arm_facts["candidate"][
        "launch_spec_sha256"
    ]:
        raise ValueError("new native package does not match focused proof")

    def evidence(name: str) -> dict[str, Any]:
        path = _private_input_path(receipt.get(f"{name}_file"), f"{name} proof")
        raw = _private_file(path)
        if hashlib.sha256(raw).hexdigest() != receipt.get(f"{name}_sha256"):
            raise ValueError(f"{name} proof changed")
        return json.loads(raw)

    first = evidence("focused_first")
    continued = evidence("focused_continuation")
    oracle = evidence("case10_oracle")
    binary_sha = receipt["candidate_binary_sha256"]
    if first.get("schema") != "butler.gpt6sol-delegation-focused.v1" or \
       first.get("installation_binary_sha256") != binary_sha or \
       first.get("failure", {}).get("code") != "turn_terminal_timeout" or \
       first.get("installation_unchanged") is not True or \
       continued.get("schema") != "butler.gpt6sol-delegation-focused-continuation.v1" or \
       continued.get("binary_sha256") != binary_sha or \
       continued.get("first_receipt_sha256") != receipt["focused_first_sha256"] or \
       continued.get("failure") is not None or \
       continued.get("installation_unchanged") is not True or \
       continued.get("shutdown", {}).get("forced_termination") is not False or \
       continued.get("shutdown", {}).get("residual_owned_process_count") != 0 or \
       continued.get("shutdown", {}).get("listener", {}).get("listener_residue") is not False or \
       continued.get("embedding") != {"active_generation_after": False,
                                      "asset_cache_after": False}:
        raise ValueError("focused native delegation or shutdown proof incomplete")
    cases = continued.get("cases", [])
    if [item.get("case") for item in cases] != [7, 8, 9, 10]:
        raise ValueError("focused child case sequence differs")
    for item in cases:
        child = item.get("child") or {}
        if item.get("parent_state") != "delivered" or \
           (item.get("child_status") or child.get("status")) != "success" or \
           (item.get("tool_status") or child.get("tool_status")) != "observed" or \
           (item.get("canonical_sources_complete")
            if item["case"] == 7 else child.get("canonical_sources_complete")) is not True:
            raise ValueError("focused related child result incomplete")
        if item["case"] < 10 and (item.get("failure_codes") or []):
            raise ValueError("focused child fixture failed before case ten")
    if oracle.get("schema") != "butler.benchmark.case10-oracle-correction.v1" or \
       oracle.get("prior_focused_continuation_sha256") != receipt[
           "focused_continuation_sha256"
       ] or oracle.get("actual_file_sha256") != cases[-1].get("child", {}).get(
           "output_sha256"
       ) or oracle.get("actual_command_stdout_match") is not True or \
       oracle.get("child_result_contains_actual_sha256") is not True or \
       oracle.get("new_assessment_failure_codes") != [] or \
       oracle.get("source_output_text_unchanged") is not True or \
       oracle.get("prompt_unchanged") is not True:
        raise ValueError("case ten focused oracle correction incomplete")
    if receipt.get("arms") != {
        arm: {"canonical_read_evidence_sha256": prior["arms"][arm][
            "canonical_read_evidence_sha256"
        ]} for arm in ("legacy", "candidate")
    }:
        raise ValueError("prior canonical-read provenance differs")


def _validate_catalog_only_readiness(receipt: dict[str, Any], model: str, reasoning: str,
                                     arm_facts: dict[str, dict[str, str]],
                                     installation: dict[str, Any], workload: dict[str, Any],
                                     expected_fixture_procedure_sha256: str | None = None) -> None:
    """Reuse reviewed F1-F7 product evidence; bind the new catalog to a real OAuth tool Turn."""
    if model != "openai/gpt-6-sol" or reasoning != "medium" or \
       receipt.get("model") != model or receipt.get("reasoning_effort") != reasoning or \
       receipt.get("fallback_settings") != {"enabled": False, "models": []} or \
       receipt.get("fixture_procedure_sha256") != (
           expected_fixture_procedure_sha256 or _fixture_procedure_sha256()
       ):
        raise ValueError("catalog-only readiness selection differs")
    prior_path = _private_input_path(receipt.get("prior_readiness_receipt_file"),
                                     "prior canonical-read receipt")
    prior_raw = _private_file(prior_path)
    if hashlib.sha256(prior_raw).hexdigest() != receipt.get("prior_readiness_receipt_sha256"):
        raise ValueError("prior canonical-read receipt changed")
    prior = json.loads(prior_raw)
    if prior.get("schema") != "butler.rust-benchmark.readiness.v3":
        raise ValueError("prior canonical-read receipt schema differs")
    prior_facts = {arm: {
        "manifest_sha256": prior["arms"][arm]["installation_manifest_sha256"],
        "launch_spec_sha256": prior["arms"][arm]["launch_spec_sha256"],
    } for arm in ("legacy", "candidate")}
    validate_readiness_receipt(prior, model=prior["model"],
                               reasoning_effort=prior["reasoning_effort"], workload=workload,
                               arm_facts=prior_facts,
                               fixture_procedure_sha256=prior["fixture_procedure_sha256"])
    expected_patch = "packages/butler-agent/src/integrations/providers/openai/catalog.ts"
    provenance = receipt.get("catalog_patch_provenance", {})
    original_value = provenance.get("legacy_original_root")
    if not isinstance(original_value, str) or not original_value:
        raise ValueError("original frozen baseline path missing")
    original_root = Path(original_value).resolve(strict=True)
    if original_root == REPO or original_root.is_relative_to(REPO) or \
       original_root == PRODUCTION_DATA or original_root.is_relative_to(PRODUCTION_DATA):
        raise ValueError("original frozen baseline overlaps source or production data")
    original_manifest = artifact_manifest(original_root)
    overlay_manifest = installation["legacy"]["manifest"]
    changed = sorted(key for key in set(original_manifest) | set(overlay_manifest)
                     if original_manifest.get(key) != overlay_manifest.get(key))
    if changed != [expected_patch] or \
       _digest(original_manifest) != provenance.get("legacy_original_manifest_sha256") or \
       overlay_manifest[expected_patch]["sha256"] != provenance.get("legacy_catalog_sha256") or \
       provenance.get("native_binary_sha256") != installation["candidate"]["manifest"].get(
           "butler-agent", {}).get("sha256"):
        raise ValueError("catalog-only artifact provenance differs")
    arms = receipt.get("arms", {})
    if set(arms) != {"legacy", "candidate"}:
        raise ValueError("catalog-only readiness arm set differs")
    fingerprints = set()
    for arm, facts in arm_facts.items():
        record = arms[arm]
        path = _private_input_path(record.get("actual_oauth_receipt_file"),
                                   f"{arm} actual OAuth receipt")
        raw = _private_file(path)
        if hashlib.sha256(raw).hexdigest() != record.get("actual_oauth_receipt_sha256"):
            raise ValueError("actual OAuth receipt changed")
        actual = json.loads(raw)
        if actual.get("arm") != arm or actual.get("status") != "observed" or \
           actual.get("model") != model or actual.get("reasoning_effort") != reasoning or \
           actual.get("fallback_settings") != {"enabled": False, "models": []} or \
           actual.get("installation_manifest_sha256") != facts["manifest_sha256"] or \
           actual.get("launch_spec_sha256") != facts["launch_spec_sha256"] or \
           actual.get("settings_readback", {}).get("status") != "observed" or \
           actual.get("turn_control_readback", {}).get("status") != "observed" or \
           actual.get("guided_turn", {}).get("terminal_state") != "delivered" or \
           actual.get("tool_journal", {}).get("canonical_reads_complete") is not True or \
           actual.get("tool_journal", {}).get("tool_names_in_order") != [
               "query_memory", "read_conversation_session"] or \
           actual.get("installation_immutable", {}).get("status") != "observed" or \
           actual.get("owned_cleanup", {}).get("residual_owned_process_count") != 0 or \
           actual.get("embedding_conditions", {}).get("active_generation_after") != "absent" or \
           actual.get("embedding_conditions", {}).get("embedding_asset_cache_after", {}).get(
               "root_present") is not False:
            raise ValueError(f"{arm} actual OAuth public tool readiness incomplete")
        fingerprints.add(actual.get("credential_reference_fingerprint"))
        if record.get("installation_manifest_sha256") != facts["manifest_sha256"] or \
           record.get("launch_spec_sha256") != facts["launch_spec_sha256"] or \
           record.get("canonical_read_evidence_sha256") != actual.get(
               "canonical_read_evidence_sha256"):
            raise ValueError(f"{arm} catalog-only readiness binding differs")
    if len(fingerprints) != 1 or None in fingerprints:
        raise ValueError("actual OAuth input differs between arms")


def _new_private_file(path: Path, data: bytes) -> None:
    with path.open("xb") as stream:
        os.fchmod(stream.fileno(), PRIVATE_MODE)
        stream.write(data)


def _allocate_port() -> int:
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def _port_still_free(port: int) -> bool:
    try:
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", port))
        return True
    except OSError:
        return False


def _prepare_arm(pair_root: Path, name: str, timezone: str,
                 fixture_source_root: Path | None = None) -> dict[str, Any]:
    arm = pair_root / name
    arm.mkdir(mode=0o700)
    data, workspace, evidence = arm / "data", arm / "workspace", arm / "evidence"
    evidence.mkdir(mode=0o700)
    home = arm / "home"
    home.mkdir(mode=PRIVATE_DIRECTORY_MODE)
    preparation_env = {key: value for key, value in os.environ.items()
                       if key in {"PATH", "LANG", "LC_ALL", "SYSTEMROOT"}}
    preparation_env.update({"HOME": str(home), "TZ": timezone})
    source_root = fixture_source_root or (REPO / "packages" / "butler-agent" / "src")
    source_root = source_root.resolve(strict=True)
    preparation_env["BUTLER_BENCHMARK_AGENT_SOURCE_ROOT"] = str(source_root)
    subprocess.run([str(BUN_PATH), str(Path(__file__).with_name("seed_canonical_fixture.ts")),
                    str(data), str(workspace)], check=True, capture_output=True,
                   env=preparation_env)
    if _active_generation_present(data) or _embedding_asset_snapshot(data)["root_present"]:
        raise ValueError("fresh isolated data has memory generation or embedding assets")
    local_day = _suppress_daily_memory_jobs(data, timezone)
    # Same Git seed and deterministic commit identity, all before timing.
    git_env = {**preparation_env, "GIT_AUTHOR_DATE": "2026-01-08T00:00:00Z",
               "GIT_COMMITTER_DATE": "2026-01-08T00:00:00Z"}
    for command in (["git", "init", "-q"], ["git", "-c", "user.name=Butler Benchmark",
                                            "-c", "user.email=benchmark@localhost", "add", "--all"],
                    ["git", "-c", "user.name=Butler Benchmark",
                     "-c", "user.email=benchmark@localhost", "commit", "-qm", "Seed workspace"]):
        subprocess.run(command, cwd=workspace, env=git_env, check=True, capture_output=True)
    auth_token = secrets.token_urlsafe(48)
    auth_file = data / "app-local-auth.json"
    _new_private_file(auth_file, json.dumps({"token": auth_token}).encode())
    folder_secret = secrets.token_urlsafe(48)
    secret_file = data / "folder-secret"
    _new_private_file(secret_file, folder_secret.encode())
    config = {
        "system": {"defaultModel": "@MODEL@", "butlerModel": "@MODEL@",
                   "openaiReasoningEffort": "@REASONING@", "devRoot": str(workspace)},
        "user": {"modelFallback": {"enabled": False, "models": []}},
        "project": {"discoveryRoots": [str(workspace)]},
    }
    return {"arm": arm, "data": data, "workspace": workspace,
            "evidence": evidence, "auth_token": auth_token, "auth_file": auth_file,
            "folder_secret": folder_secret, "secret_file": secret_file,
            "config": config, "port": _allocate_port(),
            "canonical_read_evidence": None,
            "canonical_read_evidence_sha256": None,
            "local_day": local_day,
            "daily_memory_jobs": "suppressed_for_local_day"}


def _make_env(prepared: dict[str, Any], arm: str, contract: dict[str, Any],
              provider_input: dict[str, Any]) -> dict[str, str]:
    env = {key: value for key, value in os.environ.items()
           if key in {"PATH", "LANG", "LC_ALL", "TZ", "TMPDIR", "SYSTEMROOT"}}
    if provider_input["mode"] == "environment":
        env.update(provider_input["environment"])
    home = prepared["arm"] / "home"
    home.mkdir(mode=PRIVATE_DIRECTORY_MODE, exist_ok=True)
    os.chmod(home, PRIVATE_DIRECTORY_MODE)
    env.update({
        "HOME": str(home),
        "BUTLER_DATA": str(prepared["data"]),
        "BUTLER_PROJECT_WORKSPACE": str(prepared["workspace"]),
        "BUTLER_APP_SERVER_HOST": "127.0.0.1",
        "BUTLER_APP_SERVER_PORT": str(prepared["port"]),
        "BUTLER_APP_SERVER_DB": str(prepared["data"] / "app-server" / "butler-client.sqlite"),
        "BUTLER_APP_GATEWAY_PID_FILE": "off",
        "BUTLER_APP_BUNDLED_SUPERVISOR": "1",
        "BUTLER_APP_LOCAL_AUTH_REQUIRED": "1",
        "BUTLER_APP_LOCAL_AUTH_FILE": str(prepared["auth_file"]),
        "BUTLER_PROJECT_FOLDER_TOKEN_SECRET": prepared["folder_secret"],
        "BUTLER_AGENT_MEMORY_DIAGNOSTICS": "1",
        "TZ": contract["timezone"],
        "LANG": contract["locale"],
    })
    if arm == "legacy":
        legacy_installation = str(Path(contract["legacy"]["installation_root"]).resolve(strict=True))
        env["BUTLER_HOME"] = legacy_installation
        env["BUTLER_APP_BUTLER_HOME"] = legacy_installation
    else:
        env.pop("BUTLER_HOME", None)
        env.pop("BUTLER_APP_BUTLER_HOME", None)
    return env


def _commands(spec: dict[str, Any], prepared: dict[str, Any]) -> list[list[str]]:
    replacements = {"{installation}": str(Path(spec["installation_root"]).resolve()),
                    "{data}": str(prepared["data"]), "{workspace}": str(prepared["workspace"])}
    commands = []
    for command in spec["commands"]:
        commands.append([_replace_exact(argument, replacements) for argument in command])
    return commands


def _replace_exact(value: str, replacements: dict[str, str]) -> str:
    for key, replacement in replacements.items():
        value = value.replace(key, replacement)
    return value


def _wait_ready(client: AppClient, roots: set[Identity], deadline_s: float = 90) -> tuple[int, int]:
    gateway_ns: int | None = None
    deadline = time.monotonic() + deadline_s
    while time.monotonic() < deadline:
        try:
            health = client.health()
            if health.data.get("ok") is True and gateway_ns is None:
                gateway_ns = health.response_ns
            ready = client.readiness()
            pid = ready.data.get("executor_pid")
            snapshot = collect_ps().processes
            owned = {identity.pid for identity in roots
                     if (process := snapshot.get(identity.pid)) is not None and process.identity == identity}
            while True:
                children = {process.identity.pid for process in snapshot.values() if process.ppid in owned}
                if children.issubset(owned):
                    break
                owned.update(children)
            observed = snapshot.get(pid) if isinstance(pid, int) else None
            if (ready.data.get("authenticated_gateway_ready") is True and
                ready.data.get("btcc_executor_ready") is True and observed is not None and
                pid in owned and gateway_ns is not None):
                return gateway_ns, ready.response_ns
        except AppProtocolError:
            pass
        time.sleep(0.1)
    raise RuntimeError("runtime_readiness_timeout")


def _run_arm(contract: dict[str, Any], installation: dict[str, Any], pair_root: Path,
             arm_name: str, workload: dict[str, Any],
             provider_input: dict[str, Any]) -> dict[str, Any]:
    prepared = _prepare_arm(
        pair_root, arm_name, contract["timezone"],
        fixture_source_root=Path(contract["legacy"]["installation_root"]) / "packages" / "butler-agent" / "src",
    )
    storage_preparation = None
    if arm_name == "legacy":
        # The frozen daemon performs this before startAll. Keep its cost separate
        # from readiness boot, and let the same frozen source own initialization.
        from installed_canonical_readiness import _prepare_frozen_legacy_storage
        storage_preparation = _prepare_frozen_legacy_storage(
            Path(contract["legacy"]["installation_root"]), prepared, contract["timezone"],
        )
    asset_cache_before = _embedding_asset_snapshot(prepared["data"])
    generation_before = _active_generation_present(prepared["data"])
    if asset_cache_before["root_present"] or generation_before:
        raise ValueError("isolated DATA is not a fresh no-generation embedding fixture")
    config = prepared["config"]
    config["system"]["defaultModel"] = contract["model"]
    config["system"]["butlerModel"] = contract["model"]
    config["system"]["openaiReasoningEffort"] = contract["reasoning_effort"]
    if provider_input["mode"] == "stored_credential":
        credential = provider_input["credential"]
        _write_provider_credential(prepared["data"], credential)
        config["models"] = {"registered": [_stored_model_registration(contract["model"], credential)]}
    elif provider_input["mode"] == "codex_oauth":
        _write_codex_oauth_profile(prepared["data"], provider_input["profile"])
        config["models"] = {"registered": [{
            "provider_id": "openai", "model_id": "gpt-6-sol",
            "auth_type": "codex_oauth", "auth_profile": "codex_oauth",
        }]}
    _new_private_file(prepared["data"] / "butler.config.json", json.dumps(config).encode())
    if not _port_still_free(prepared["port"]):
        raise RuntimeError("port_race_before_spawn")
    # Refresh the supported scheduler markers immediately before the actual
    # owners start, including when preparation crossed a local midnight.
    prepared["local_day"] = _suppress_daily_memory_jobs(prepared["data"], contract["timezone"])
    env = _make_env(prepared, arm_name, contract, provider_input)
    launch_commands = _commands(contract[arm_name], prepared)
    launch = OwnedLaunch(launch_commands,
                         prepared["workspace"], env, prepared["evidence"] / "backend-logs")
    started = time.monotonic_ns()
    roots = launch.start()
    meter = ProcessMeter(roots)
    try:
        meter.start()
    except BaseException:
        launch.shutdown(set(roots))
        raise
    result: dict[str, Any] = {"accuracy_passed": False, "failure_codes": [], "cases": [],
                              "installation_manifest_sha256": installation["manifest_sha256"],
                              "launch_spec_sha256": installation["launch_spec_sha256"],
                              "resolved_launch_command_sha256": _digest({"commands": launch_commands}),
                              "canonical_read_evidence_sha256": installation["canonical_read_evidence_sha256"],
                              "g3_executable_and_library_inventory": installation["distribution"]}
    if storage_preparation is not None:
        result["storage_preparation"] = storage_preparation
    try:
        client = AppClient(f"http://127.0.0.1:{prepared['port']}", prepared["auth_token"])
        gateway_ns, full_ns = _wait_ready(client, set(roots))
        result["boot_gateway_ms"] = (gateway_ns - started) / 1_000_000
        result["boot_full_ms"] = (full_ns - started) / 1_000_000
        result["full_readiness"] = {"sample": meter.latest(), "physical": meter.physical_checkpoint()}
        public_settings_update = client.update_model_settings(
            contract["model"], contract["reasoning_effort"])
        if public_settings_update.data.get("model") != contract["model"] or \
           public_settings_update.data.get("reasoning_effort") != contract["reasoning_effort"]:
            raise RuntimeError("public_model_settings_update_mismatch")
        effective = client.settings().data
        fallback = effective.get("model_fallback")
        if effective.get("model") != contract["model"] or \
           effective.get("reasoning_effort") != contract["reasoning_effort"] or \
           fallback != {"enabled": False, "models": []}:
            raise RuntimeError("effective_model_configuration_mismatch")
        result["effective_model_configuration"] = {
            "model": effective["model"],
            "reasoning_effort": effective["reasoning_effort"],
            "fallback_settings": fallback,
            "source": "authenticated_public_settings_patch_then_read",
        }
        secret_file = prepared["secret_file"]
        token_file = prepared["data"] / "folder-token"
        subprocess.run([str(BUN_PATH), str(Path(__file__).with_name("issue_workspace_token.ts")),
                        str(Path(contract["legacy"]["installation_root"])),
                        str(prepared["workspace"]), str(secret_file), str(token_file)],
                       check=True, capture_output=True)
        project = client.create_project(_private_file(token_file).decode())
        project_id = project.data["project"]["id"]
        time.sleep(30)
        result["prework_idle"] = {"sample": meter.latest(), "physical": meter.physical_checkpoint()}
        source_message_ids = {source["id"]: source["message_id"] for source in workload["sources"]}
        last_terminal_s: float | None = None
        for case in workload["cases"]:
            case_id = case["id"]
            session_hint = f"rust-benchmark-{case_id:02d}"
            created = client.create_session(project_id, session_hint)
            session_id = created.data["session"]["id"]
            controls = client.set_controls(session_id, contract["model"], contract["reasoning_effort"])
            before = workspace_hashes(prepared["workspace"])
            case_start = time.monotonic()
            case_result: dict[str, Any] = {
                "case": case_id,
                "session_creation_ms": (created.response_ns - created.request_ns) / 1_000_000,
                "controls_ms": (controls.response_ns - controls.request_ns) / 1_000_000,
                "failure_codes": [],
            }
            sample_start = case_start
            sample_end: float | None = None
            try:
                observed = observe_turn(client, session_id=session_id,
                                        client_message_id=f"rust-benchmark-{case_id:02d}",
                                        prompt=full_prompt(workload, case), model=contract["model"],
                                        reasoning_effort=contract["reasoning_effort"],
                                        require_assistant_message=case_id < 7)
                assessment_turn_id = observed.turn_id
                assessment_text = observed.final_text
                assessment_terminal = observed.terminal_state
                terminal_ns = observed.final_ns
                if case_id >= 7:
                    case_result["parent_ack"] = {
                        "state": observed.terminal_state,
                        "latency_ms": (observed.final_ns - observed.request_ns) / 1_000_000
                        if observed.final_ns else None,
                    }
                    delegated = observe_delegated_result(
                        client, parent_session_id=session_id, parent_turn_id=observed.turn_id)
                    assessment_turn_id = delegated.child_turn_id
                    assessment_text = delegated.final_text
                    assessment_terminal = "delivered" if delegated.status == "success" else delegated.status
                    terminal_ns = delegated.final_ns
                    case_result["delegated_work"] = {
                        "status": delegated.status,
                        "relation_id": delegated.relation_id,
                        "child_session_id": delegated.child_session_id,
                        "child_turn_id": delegated.child_turn_id,
                        "basis": "exact_parent_turn_public_session_view",
                        "terminal_time_basis": "150ms_public_view_poll_plus_http_observation",
                    }
                tools = inspect_tool_journal(prepared["data"], assessment_turn_id,
                                             {source_message_ids[id] for id in case["source_ids"]}, set())
                after = workspace_hashes(prepared["workspace"])
                if case_id == 10:
                    tools["command_hash_observed"] = inspect_run_command_hash(
                        prepared["data"], assessment_turn_id,
                        after.get(case["output"]["path"], ""),
                    )
                case_result["failure_codes"] = assess_case(case, assessment_text,
                                                             assessment_terminal, tools, before, after)
                case_result["admission_ms"] = (observed.admission_ns - observed.request_ns) / 1_000_000
                case_result["final_ms"] = (terminal_ns - observed.request_ns) / 1_000_000 if terminal_ns else None
                case_result["first_public_activity_ms"] = (
                    (observed.first_public_activity_ns - observed.request_ns) / 1_000_000
                    if observed.first_public_activity_ns else None)
                case_result["tool_calls"] = tools.get("calls") if tools.get("status") == "observed" else "unavailable"
                case_result["tool_evidence_summary"] = {
                    "status": tools.get("status", "unavailable"),
                    "required_tools_completed": tools.get("required_tools_completed"),
                    "canonical_sources_complete": tools.get("canonical_sources_complete"),
                    "canonical_source_count": len(tools.get("canonical_sources_read", [])),
                    "call_count": len(tools.get("calls", [])),
                }
                if case_id == 10:
                    case_result["tool_evidence_summary"]["command_hash_observed"] = tools.get(
                        "command_hash_observed"
                    )
                case_result["public_tool_progress"] = (
                    observed.public_tool_progress if case_id < 7 else {
                        "status": "unavailable", "reason": "child_progress_not_in_parent_sse"})
                if case_id == 9:
                    case_result["input_read_tool_evidence"] = (
                        "observed_read_file" if tools.get("status") == "observed" and
                        any(row["tool_name"] == "read_file" and row["status"] == "completed"
                            for row in tools.get("calls", [])) else "unavailable")
                case_result["event_stream_status"] = observed.event_stream_status
                if observed.event_stream_status != "observed":
                    case_result["failure_codes"].append("event_stream_incomplete")
                sample_start = observed.request_ns / 1_000_000_000
                sample_end = terminal_ns / 1_000_000_000 if terminal_ns else None
                if case_id == 10 and terminal_ns is not None:
                    last_terminal_s = terminal_ns / 1_000_000_000
                # The public App path exposes tool progress but no provider
                # first-content boundary. Keep the residual unavailable when
                # either side of the subtraction is missing.
                request_wall_ns = terminal_ns - observed.request_ns if terminal_ns else None
                tool_intervals_ns = None
                if case_id < 7 and observed.public_tool_progress.get("status") == "observed":
                    tool_intervals_ns = [
                        (int(row["start_after_request_ms"] * 1_000_000),
                         int(row["end_after_request_ms"] * 1_000_000))
                        for row in observed.public_tool_progress.get("intervals", [])
                    ]
                residual_ns = local_residual_ns(request_wall_ns, None, tool_intervals_ns)
                case_result["provider_first_content_ms"] = {
                    "status": "unavailable",
                    "reason": "no_public_provider_first_content_boundary",
                }
                case_result["local_residual_ms"] = {
                    "status": "observed" if residual_ns is not None else "unavailable",
                    "value": residual_ns / 1_000_000 if residual_ns is not None else None,
                    "reason": None if residual_ns is not None else "provider_interval_unavailable",
                }
            except (AppProtocolError, OSError, ValueError) as error:
                case_result["failure_codes"] = [getattr(error, "code", type(error).__name__)]
                case_result["final_ms"] = None
                if isinstance(error, AppProtocolError) and error.request_kind:
                    case_result["transport_failure"] = {
                        "request_kind": error.request_kind,
                        "cause_code": error.cause_code,
                        "http_status": error.status,
                        "elapsed_ms": error.elapsed_ms,
                    }
            case_end = time.monotonic()
            case_result["process"] = summarize_samples(meter.slice(sample_start, sample_end or case_end))
            case_result["physical"] = meter.physical_checkpoint()
            case_result.setdefault("provider_first_content_ms", {
                "status": "unavailable", "reason": "no_public_provider_first_content_boundary"})
            case_result.setdefault("local_residual_ms", {
                "status": "unavailable", "value": None, "reason": "provider_interval_unavailable"})
            case_result.setdefault("public_tool_progress", {
                "status": "unavailable", "reason": "turn_event_observation_unavailable"})
            case_result.setdefault("tool_evidence_summary", {
                "status": "unavailable", "reason": "tool_journal_observation_unavailable"})
            result["cases"].append(case_result)
        final_completed = last_terminal_s if last_terminal_s is not None else time.monotonic()
        if last_terminal_s is None:
            result["failure_codes"].append("postwork_terminal_anchor_unavailable")
        for delay in (1, 30, 120):
            time.sleep(max(0, final_completed + delay - time.monotonic()))
            result[f"postwork_idle_{delay}s"] = {"sample": meter.latest(),
                                                   "physical": meter.physical_checkpoint()}
        pre = result["prework_idle"]
        post = result["postwork_idle_120s"]
        pre_sample, post_sample = pre["sample"], post["sample"]
        pre_physical, post_physical = pre["physical"], post["physical"]
        result["retention_after_120s"] = {
            "rss_sum_proxy_delta_bytes":
                post_sample["rss_sum_proxy_bytes"] - pre_sample["rss_sum_proxy_bytes"]
                if pre_sample and post_sample else None,
            "physical_footprint_sum_proxy_delta_bytes":
                post_physical["physical_footprint_sum_proxy_bytes"] - pre_physical["physical_footprint_sum_proxy_bytes"]
                if pre_physical.get("status") == post_physical.get("status") == "observed" else None,
        }
        result["accuracy_passed"] = len(result["cases"]) == 10 and all(
            not case["failure_codes"] for case in result["cases"])
        result["failure_codes"].extend(sorted({code for case in result["cases"]
                                                for code in case["failure_codes"]}))
    except (AppProtocolError, OSError, RuntimeError, KeyError, ValueError) as error:
        result["failure_codes"].append(getattr(error, "code", type(error).__name__))
    finally:
        meter.stop()
        result["process_total"] = summarize_samples(meter.samples)
        try:
            result["shutdown"] = launch.shutdown(meter.accounting.known)
            if result["shutdown"]["forced_termination"] or result["shutdown"]["residual_owned_process_count"]:
                result["failure_codes"].append("shutdown_lifecycle_failure")
        except Exception:
            result["failure_codes"].append("shutdown_observation_unavailable")
            result["shutdown"] = {"status": "unavailable"}
        try:
            result["listener_and_socket_residue"] = inspect_listener_residue(
                prepared["port"], meter.accounting.known)
            listener = result["listener_and_socket_residue"]
            if listener.get("status") != "observed":
                result.setdefault("evidence_gaps", []).append("listener_observation_unavailable")
            elif listener.get("listener_count"):
                result["failure_codes"].append("residual_listener_socket")
        except Exception:
            result["listener_and_socket_residue"] = {
                "status": "unavailable", "reason": "listener_observer_unavailable"}
            result.setdefault("evidence_gaps", []).append("listener_observation_unavailable")
        try:
            verify_artifact_unchanged(installation["root"], installation["manifest"])
        except Exception:
            result["failure_codes"].append("immutable_installation_changed")
        try:
            asset_cache_after = _embedding_asset_snapshot(prepared["data"])
            generation_after = _active_generation_present(prepared["data"])
            local_day_after = datetime.now(ZoneInfo(contract["timezone"])).date().isoformat()
            no_asset_download_observed = (
                not asset_cache_before["root_present"] and
                not asset_cache_after["root_present"]
            )
            no_active_generation = not generation_before and not generation_after
            scheduler_window_held = local_day_after == prepared["local_day"]
            result["embedding_readiness"] = {
                "status": "observed",
                "data_scope": "fresh_isolated_DATA",
                "active_generation_before": "absent",
                "active_generation_after": "absent" if not generation_after else "present",
                "embedding_asset_cache_before": asset_cache_before,
                "embedding_asset_cache_after": asset_cache_after,
                "no_embedding_asset_download_observed": no_asset_download_observed,
                "embedding_owner_invocations": "unavailable_no_public_owner_registry",
                "canonical_query_read_path": "query_memory_then_read_conversation_session_v2",
                "recall_owner_condition": "active_generation_required_before_vector_request",
                "daily_session_sync": "suppressed_for_local_day",
                "daily_consolidation_cycle": "suppressed_for_local_day",
                "local_day_window_held": scheduler_window_held,
            }
            if not no_asset_download_observed:
                result["failure_codes"].append("embedding_asset_activity_observed")
            if not no_active_generation:
                result["failure_codes"].append("active_memory_generation_observed")
            if not scheduler_window_held:
                result["failure_codes"].append("memory_schedule_suppression_window_expired")
        except Exception:
            result["embedding_readiness"] = {
                "status": "unavailable",
                "reason": "embedding_owner_condition_observation_failed",
                "embedding_owner_invocations": "unavailable_no_public_owner_registry",
            }
            result["failure_codes"].append("embedding_readiness_unavailable")
        progress_cases = [case.get("public_tool_progress", {}) for case in result["cases"]]
        started_progress = [row for row in progress_cases
                            if isinstance(row.get("peak_active_tool_calls"), int)]
        known_tool_peaks = [row["peak_active_tool_calls"] for row in started_progress]
        process_peak = result["process_total"].get("process_peak_count")
        result["owner_counts"] = {
            "status": "partial",
            "owned_backend_processes": {
                "status": "observed" if isinstance(process_peak, int) else "unavailable",
                "peak": process_peak,
                "basis": "identity_checked_descendant_process_tree",
            },
            "provider": {"status": "unavailable", "reason": "no_public_provider_owner_registry"},
            "tool": {"status": "unavailable", "reason": "public_progress_exposes_calls_not_owner_registry"},
            "lance": {"status": "unavailable", "reason": "no_public_lance_owner_registry"},
            "fetch": {"status": "unavailable", "reason": "no_public_fetch_owner_registry"},
        }
        result["public_tool_activity"] = {
            "status": ("observed" if started_progress and all(
                row.get("status") == "observed" for row in started_progress)
                else "partial" if started_progress else "unavailable"),
            "peak_active_calls": max(known_tool_peaks) if known_tool_peaks else None,
            "cases_with_started_calls": len(started_progress),
            "cases_with_incomplete_intervals": sum(
                row.get("status") != "observed" for row in started_progress),
            "basis": "public_progress_sse_observation",
        }
        if result["failure_codes"]:
            result["accuracy_passed"] = False
    successful_final = [case["final_ms"] for case in result["cases"]
                        if isinstance(case.get("final_ms"), (int, float))]
    successful_admission = [case["admission_ms"] for case in result["cases"]
                            if isinstance(case.get("admission_ms"), (int, float))]
    result["final_turn_median_ms"] = median(successful_final) if len(successful_final) == 10 else None
    result["admission_median_ms"] = median(successful_admission) if len(successful_admission) == 10 else None
    result["cpu_observed_seconds"] = result["process_total"]["observed_cpu_seconds_delta"]
    for name, checkpoint in (("rss_prework_bytes", "prework_idle"),
                             ("rss_post120_bytes", "postwork_idle_120s")):
        sample = result.get(checkpoint, {}).get("sample")
        result[name] = sample.get("rss_sum_proxy_bytes") if sample else None
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("contract", type=Path, help="private frozen campaign input JSON")
    parser.add_argument("--inventory", action="store_true", help="hash installation trees only; no launch")
    parser.add_argument("--execute", action="store_true", help="launch only after separate final campaign authorization")
    args = parser.parse_args()
    contract = json.loads(_private_file(args.contract))
    workload = load_workload()
    if args.inventory:
        bun = bun_executable_evidence()
        print(json.dumps({
            "baseline_bun_executable_sha256": bun.get("sha256"),
            "installation_manifest_sha256": {
                arm: _digest(artifact_manifest(Path(contract[arm]["installation_root"])))
                for arm in ("legacy", "candidate")},
            "g3_executable_and_library_inventory": {
                arm: inspect_distribution(Path(contract[arm]["installation_root"]),
                                          contract[arm]["commands"])
                for arm in ("legacy", "candidate")},
        }))
        return
    installation = _validate_contract(contract)
    provider_input = _load_provider_input(contract)
    if not args.execute:
        print(json.dumps({"preflight": "ready_for_root_review",
                          "selected_model": contract["model"],
                          "reasoning_effort": contract["reasoning_effort"],
                          "fallback_settings": {"enabled": False, "models": []},
                          "workload_sha256": hashlib.sha256(Path(__file__).with_name("workload.json").read_bytes()).hexdigest(),
                          "fixture_procedure_sha256": _fixture_procedure_sha256(),
                          "baseline_bun_executable_sha256": installation["_baseline_bun_executable_sha256"],
                          "installation_manifest_sha256": {arm: installation[arm]["manifest_sha256"]
                                                           for arm in ("legacy", "candidate")},
                          "launch_spec_sha256": {arm: installation[arm]["launch_spec_sha256"]
                                                 for arm in ("legacy", "candidate")},
                          "g3_executable_and_library_inventory": {
                              arm: installation[arm]["distribution"]
                              for arm in ("legacy", "candidate")}}))
        return
    if contract.get("final_campaign_authorized") is not True:
        raise ValueError("final campaign authorization absent")
    os.umask(0o077)
    scratch_parent = Path(contract["scratch_parent"]).resolve(strict=True)
    if scratch_parent == REPO or scratch_parent.is_relative_to(REPO) or \
       scratch_parent == Path.home() / ".butler" or scratch_parent.is_relative_to(Path.home() / ".butler"):
        raise ValueError("scratch parent overlaps source or production")
    if any(scratch_parent == installation[arm]["root"] or
           scratch_parent.is_relative_to(installation[arm]["root"])
           for arm in ("legacy", "candidate")):
        raise ValueError("scratch parent overlaps an installation")
    root = Path(tempfile.mkdtemp(prefix="butler-rust-benchmark-", dir=scratch_parent))
    root.chmod(0o700)
    pairs = []
    for index, order in enumerate(ARM_ORDER, start=1):
        pair_root = root / f"pair-{index}"
        pair_root.mkdir(mode=0o700)
        pair: dict[str, Any] = {"order": list(order)}
        for arm in order:
            try:
                pair[arm] = _run_arm(contract, installation[arm], pair_root, arm, workload,
                                     provider_input)
            except Exception as error:
                pair[arm] = {"accuracy_passed": False,
                             "failure_codes": [getattr(error, "code", type(error).__name__)],
                             "cases": [], "attempt_aborted": True}
        pairs.append(pair)
    comparisons = {metric: paired_report(pairs, metric) for metric in (
        "boot_gateway_ms", "boot_full_ms", "admission_median_ms", "final_turn_median_ms",
        "cpu_observed_seconds", "rss_prework_bytes", "rss_post120_bytes")}
    report = {"schema": "butler.rust-benchmark.report.v1",
              "metadata": {"baseline_revision": contract["baseline_revision"],
                           "harness_files_sha256": contract.get("harness_files_sha256"),
                           "selected_model": contract["model"],
                           "reasoning_effort": contract["reasoning_effort"],
                           "fallback_settings": {"enabled": False, "models": []},
                           "candidate_revision": contract["candidate_revision"],
                           "legacy_toolchain": contract["legacy_toolchain"],
                           "candidate_toolchain": contract["candidate_toolchain"],
                           "candidate_features": contract["candidate_features"],
                           "baseline_bun_executable_sha256": installation["_baseline_bun_executable_sha256"],
                           "fixture_procedure_sha256": _fixture_procedure_sha256(),
                           "launch_spec_sha256": {arm: installation[arm]["launch_spec_sha256"]
                                                  for arm in ("legacy", "candidate")},
                           "os": platform.mac_ver()[0], "architecture": platform.machine(),
                           "installation_file_counts": {arm: sum(
                               entry["type"] == "file" for entry in installation[arm]["manifest"].values())
                               for arm in ("legacy", "candidate")},
                           "g3_executable_and_library_inventory": {
                               arm: installation[arm]["distribution"]
                               for arm in ("legacy", "candidate")}},
              "pairs": pairs,
              "comparisons": comparisons,
              "first_public_answer_token": "unavailable",
              "tree_peak_physical_footprint": "unavailable"}
    _new_private_file(root / "report.json", json.dumps(report, ensure_ascii=False, indent=2).encode())
    print(json.dumps({"campaign": "finished", "pairs_attempted": len(pairs),
                      "report_sha256": hashlib.sha256((root / "report.json").read_bytes()).hexdigest()}))


if __name__ == "__main__":
    main()
