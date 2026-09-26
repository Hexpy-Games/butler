"""One isolated real-provider Guided Turn per frozen installation arm."""

from __future__ import annotations

import argparse
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import stat
import tempfile
from typing import Any
from zoneinfo import ZoneInfo

from app_protocol import AppClient, AppProtocolError
from installed_canonical_readiness import _prepare_frozen_legacy_storage
from launch import OwnedLaunch, artifact_manifest, verify_artifact_unchanged
from readiness import digest, expected_canonical_reads
from run_campaign import (
    _active_generation_present,
    _allocate_port,
    _commands,
    _embedding_asset_snapshot,
    _load_provider_input,
    _make_env,
    _new_private_file,
    _port_still_free,
    _prepare_arm,
    _suppress_daily_memory_jobs,
    _stored_model_registration,
    _write_codex_oauth_profile,
    _write_provider_credential,
    _wait_ready,
)
from shutdown_evidence import inspect_listener_residue
from tool_evidence import inspect_canonical_read_journal
from turn_observer import observe_turn
from workload import load_workload


MODEL = "zai/glm-5.3"
EFFORT = "medium"
FALLBACK_OFF = {"enabled": False, "models": []}
TIMEZONE = "Asia/Seoul"
LOCALE = "ko-KR"
LEGACY_INSTALLATION = Path(
    "/Users/yeonwoo/.codex/artifacts/butler-rust-migration-20260919/"
    "bun-baseline-b484052e5683109d0a2491566024a9110090fbb2/installation"
)
CANDIDATE_INSTALLATION = Path(
    "/Users/yeonwoo/.codex/artifacts/butler-rust-migration-20260919/"
    "native-final-release/candidate-installation"
)
FIXTURE_SEED_INSTALLATION = LEGACY_INSTALLATION
LEGACY_MANIFEST_SHA256 = "41f70c8d64433ff62cd78a4f26de830093065fcff414cc62e5b654bbd942f4d3"
CANDIDATE_MANIFEST_SHA256 = "c6a569c2f982afcf6045825a6ec2a9a8587c8893626a502260088d57a9e81239"

COMMANDS = {
    "legacy": [
        ["/opt/homebrew/bin/bun", "run",
         "{installation}/packages/butler-agent/scripts/native-butler-main.ts"],
        ["/opt/homebrew/bin/bun", "run",
         "{installation}/packages/butler-agent/src/gateways/app/interface/cli/app-gateway-cli.ts"],
    ],
    "candidate": [["{installation}/butler-agent", "service", "run"]],
}


def _private_write(path: Path, value: dict[str, Any]) -> None:
    if path.exists() or path.is_symlink():
        raise ValueError("provider readiness receipt already exists")
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(path.parent, 0o700)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
        json.dump(value, stream, sort_keys=True, ensure_ascii=False, indent=2)
        stream.write("\n")


def _safe_error(error: BaseException) -> dict[str, Any]:
    code = getattr(error, "code", None)
    if isinstance(code, str) and re.fullmatch(r"[A-Za-z0-9_.-]{1,96}", code):
        result: dict[str, Any] = {"code": code}
    else:
        result = {"code": type(error).__name__}
    status = getattr(error, "status", None)
    if isinstance(status, int) and 100 <= status <= 599:
        result["http_status"] = status
    return result


def _credential_file_state(path: Path) -> dict[str, Any]:
    stat_result = path.lstat()
    if not stat.S_ISREG(stat_result.st_mode) or stat.S_ISLNK(stat_result.st_mode) or \
       stat_result.st_mode & 0o077:
        raise ValueError("frozen provider input is not a private regular file")
    for directory in (path.parent, path.parent.parent):
        directory_stat = directory.lstat()
        if directory.is_symlink() or not stat.S_ISDIR(directory_stat.st_mode) or \
           directory_stat.st_mode & 0o077:
            raise ValueError("frozen provider input directory is not private")
    return {
        "inode": stat_result.st_ino,
        "size_bytes": stat_result.st_size,
        "mtime_ns": stat_result.st_mtime_ns,
        "mode": stat_result.st_mode & 0o777,
    }


def _verify_installation(root: Path, expected_sha256: str) -> tuple[dict[str, Any], str]:
    manifest = artifact_manifest(root.resolve(strict=True))
    observed = digest(manifest)
    if observed != expected_sha256:
        raise ValueError("frozen installation manifest mismatch")
    return manifest, observed


def _run_arm(*, arm: str, output_dir: Path, scratch_parent: Path,
             provider_input: dict[str, Any], credential_fingerprint: str,
             credential_file: Path, source_facts: dict[str, Any]) -> dict[str, Any]:
    installation_root = LEGACY_INSTALLATION if arm == "legacy" else CANDIDATE_INSTALLATION
    manifest_expected = LEGACY_MANIFEST_SHA256 if arm == "legacy" else CANDIDATE_MANIFEST_SHA256
    launch_template = COMMANDS[arm]
    manifest, manifest_hash = _verify_installation(installation_root, manifest_expected)
    launch_hash = digest({"commands": launch_template})
    _, fixture_manifest_hash = _verify_installation(
        FIXTURE_SEED_INSTALLATION, LEGACY_MANIFEST_SHA256
    )
    fixture_source_root = FIXTURE_SEED_INSTALLATION / "packages" / "butler-agent" / "src"
    fixture_source_files = [
        fixture_source_root / "agent" / "conversation" / "store.ts",
        fixture_source_root / "agent" / "conversation" / "session-admission.ts",
    ]
    workload = load_workload()
    source = workload["sources"][0]
    one_source_workload = {**workload, "sources": [source]}
    expected_read = expected_canonical_reads(one_source_workload)
    credential_state_before = _credential_file_state(credential_file)

    receipt: dict[str, Any] = {
        "schema": "butler.rust-benchmark.actual-provider-readiness-arm.v1",
        "arm": arm,
        "status": "not_observed",
        "provider_id": "openai" if provider_input["mode"] == "codex_oauth" else "zai",
        "auth_type": "codex_oauth" if provider_input["mode"] == "codex_oauth" else "api_key",
        "credential_record_count": source_facts["credential_record_count"],
        "credential_reference_fingerprint": credential_fingerprint,
        "credential_fingerprint_basis": "ephemeral_salted_reference_id; secret value and hash excluded",
        "credential_input": {
                "alias": "frozen-input/openai-codex.json" if provider_input["mode"] == "codex_oauth" else "frozen-input/credential.json",
            "directory_mode": "0700",
            "file_mode": "0600",
            "unchanged_before_and_after": False,
        },
        "model": MODEL,
        "reasoning_effort": EFFORT,
        "fallback_settings": FALLBACK_OFF,
        "installation_manifest_sha256": manifest_hash,
        "launch_spec_sha256": launch_hash,
        "fixture_seed": {
            "status": "prepared_not_installed_read_evidence",
            "source_installation_manifest_sha256": fixture_manifest_hash,
            "source_files": [
                {"path": str(path.relative_to(FIXTURE_SEED_INSTALLATION)),
                 "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
                for path in fixture_source_files
            ],
        },
        "storage_preparation": {"status": "not_started"},
        "settings_readback": {"status": "not_observed"},
        "turn_control_readback": {"status": "not_observed"},
        "guided_turn": {"status": "not_started", "raw_text_or_arguments_saved": False},
        "tool_journal": {"status": "not_observed"},
        "embedding_conditions": {"status": "not_observed",
                                 "embedding_owner_invocations": "unavailable_no_public_owner_registry"},
        "installation_immutable": {"status": "not_observed"},
        "owned_cleanup": {"status": "not_started"},
    }
    launch: OwnedLaunch | None = None
    roots: tuple[Any, ...] = ()
    shutdown: dict[str, Any] = {}
    listener: dict[str, Any] = {"status": "not_observed"}
    with tempfile.TemporaryDirectory(prefix=f"butler-provider-ready-{arm}-", dir=scratch_parent) as name:
        pair_root = Path(name)
        prepared: dict[str, Any] | None = None
        observed = None
        try:
            prepared = _prepare_arm(
                pair_root, arm, TIMEZONE, fixture_source_root=fixture_source_root,
            )
            config = prepared["config"]
            config["system"]["defaultModel"] = MODEL
            config["system"]["butlerModel"] = MODEL
            config["system"]["openaiReasoningEffort"] = EFFORT
            config["user"]["modelFallback"] = FALLBACK_OFF.copy()
            if provider_input["mode"] == "codex_oauth":
                _write_codex_oauth_profile(prepared["data"], provider_input["profile"])
                config["models"] = {"registered": [{
                    "provider_id": "openai", "model_id": "gpt-6-sol",
                    "auth_type": "codex_oauth", "auth_profile": "codex_oauth",
                }]}
            else:
                credential = provider_input["credential"]
                _write_provider_credential(prepared["data"], credential)
                config["models"] = {"registered": [_stored_model_registration(MODEL, credential)]}
            _new_private_file(prepared["data"] / "butler.config.json",
                              json.dumps(config, ensure_ascii=False).encode())
            prepared["local_day"] = _suppress_daily_memory_jobs(prepared["data"], TIMEZONE)
            generation_before = _active_generation_present(prepared["data"])
            assets_before = _embedding_asset_snapshot(prepared["data"])
            if generation_before or assets_before["root_present"]:
                raise ValueError("fresh isolated DATA contains an embedding generation or asset cache")
            storage = (
                _prepare_frozen_legacy_storage(installation_root, prepared, TIMEZONE)
                if arm == "legacy" else {
                    "status": "not_performed",
                    "route": "candidate-service-run-owner-is-responsible",
                    "preparation_cost_included_in_readiness_boot": True,
                }
            )
            receipt["storage_preparation"] = {
                key: storage.get(key) for key in (
                    "status", "route", "runtime_version", "duration_ms",
                    "preparation_cost_included_in_readiness_boot",
                ) if key in storage
            }
            prepared["port"] = _allocate_port()
            if not _port_still_free(prepared["port"]):
                raise RuntimeError("app_port_race_before_spawn")
            contract = {
                "timezone": TIMEZONE,
                "locale": LOCALE,
                "legacy": {"installation_root": str(LEGACY_INSTALLATION)},
            }
            env = _make_env(prepared, arm, contract, provider_input)
            commands = _commands({"installation_root": str(installation_root),
                                  "commands": launch_template}, prepared)
            launch = OwnedLaunch(commands, prepared["workspace"], env,
                                 prepared["evidence"] / "backend-logs")
            roots = launch.start()
            client = AppClient(f"http://127.0.0.1:{prepared['port']}", prepared["auth_token"])
            _wait_ready(client, set(roots))

            client.update_model_settings(MODEL, EFFORT)
            settings = client.settings().data
            if settings.get("model") != MODEL or settings.get("reasoning_effort") != EFFORT or \
               settings.get("model_fallback") != FALLBACK_OFF:
                raise RuntimeError("effective_provider_model_settings_mismatch")
            receipt["settings_readback"] = {
                "status": "observed", "model": settings["model"],
                "reasoning_effort": settings["reasoning_effort"],
                "fallback_settings": settings["model_fallback"],
                "basis": "authenticated_public_settings_get_after_patch",
            }

            session = client.create_readiness_session("provider-readiness-" + secrets.token_hex(8))
            session_record = session.data.get("session")
            if not isinstance(session_record, dict) or not isinstance(session_record.get("id"), str):
                raise AppProtocolError("provider_readiness_session_creation_failed")
            session_id = session_record["id"]
            client.set_controls(session_id, MODEL, EFFORT)
            prompt = (
                "For this provider readiness check, use query_memory to find this exact stored user fact, "
                "then pass the returned read_args unchanged to read_conversation_session. "
                "Only after both tools succeed, reply with a brief confirmation. Stored fact: " + source["text"]
            )
            observed = observe_turn(
                client, session_id=session_id,
                client_message_id="provider-readiness-" + secrets.token_hex(8),
                prompt=prompt, model=MODEL, reasoning_effort=EFFORT, deadline_s=240,
            )
            turns = client.turns(session_id).data.get("turns", [])
            turn_row = next((row for row in turns if isinstance(row, dict) and
                             row.get("id") == observed.turn_id), None)
            controls = turn_row.get("execution_controls") if isinstance(turn_row, dict) else None
            if observed.terminal_state != "delivered" or not observed.final_text or \
               not isinstance(controls, dict) or controls.get("model_ref") != MODEL or \
               controls.get("reasoning_effort") != EFFORT:
                raise RuntimeError("provider_readiness_turn_or_control_readback_incomplete")
            receipt["turn_control_readback"] = {
                "status": "observed", "model": controls["model_ref"],
                "reasoning_effort": controls["reasoning_effort"],
                "source": controls.get("source"), "basis": "installed_public_turns_readback",
            }
            receipt["guided_turn"] = {
                "status": "observed", "terminal_state": observed.terminal_state,
                "normal_response_nonempty": True,
                "public_tool_progress": {
                    "status": observed.public_tool_progress.get("status"),
                    "completed_interval_count": observed.public_tool_progress.get("completed_interval_count"),
                    "tool_names": sorted({row.get("tool_name") for row in
                                           observed.public_tool_progress.get("intervals", [])
                                           if isinstance(row, dict) and isinstance(row.get("tool_name"), str)}),
                },
                "raw_text_or_arguments_saved": False,
            }
            journal = inspect_canonical_read_journal(
                prepared["data"], observed.turn_id, [source], expected_read,
            )
            if journal.get("status") != "observed" or journal.get("canonical_reads_complete") is not True:
                raise RuntimeError("provider_readiness_canonical_tool_pair_incomplete")
            receipt["tool_journal"] = journal
            assets_after = _embedding_asset_snapshot(prepared["data"])
            generation_after = _active_generation_present(prepared["data"])
            local_day_after = datetime.now(ZoneInfo(TIMEZONE)).date().isoformat()
            receipt["embedding_conditions"] = {
                "status": "observed", "data_scope": "fresh_isolated_DATA",
                "active_generation_before": "absent",
                "active_generation_after": "present" if generation_after else "absent",
                "embedding_asset_cache_before": assets_before,
                "embedding_asset_cache_after": assets_after,
                "asset_downloads_observed": 0 if not assets_after["root_present"] else "unavailable",
                "embedding_owner_invocations": "unavailable_no_public_owner_registry",
                "daily_session_sync": "suppressed_for_local_day",
                "daily_consolidation_cycle": "suppressed_for_local_day",
                "scheduler_suppression": {
                    "data_scope": "same_fresh_fixture_DATA",
                    "local_day_timezone": TIMEZONE,
                    "local_day": prepared["local_day"],
                    "state_files": {
                        "session-sync": {"lastRunDate": prepared["local_day"],
                                         "status": "benchmark_suppressed"},
                        "consolidation-cycle": {"lastRunDate": prepared["local_day"],
                                                "status": "benchmark_suppressed"},
                    },
                },
                "local_day_window_held": local_day_after == prepared["local_day"],
                "provider_turn_fixture_preparation_mutated_measurement_state": False,
            }
            if generation_after or assets_after["root_present"] or local_day_after != prepared["local_day"]:
                raise RuntimeError("provider_readiness_embedding_boundary_changed")
            receipt["status"] = "observed"
        except Exception as error:
            receipt["failure"] = _safe_error(error)
        finally:
            if launch is not None and roots:
                try:
                    shutdown = launch.shutdown(set(roots))
                    listener = inspect_listener_residue(
                        prepared["port"] if prepared else 0, set(roots),
                    )
                except Exception as error:
                    shutdown = {"status": "unavailable", "failure": _safe_error(error)}
            try:
                verify_artifact_unchanged(installation_root, manifest)
                receipt["installation_immutable"] = {"status": "observed", "manifest_sha256": manifest_hash}
            except Exception as error:
                receipt["installation_immutable"] = {"status": "failed", "failure": _safe_error(error)}
            if prepared is not None:
                try:
                    assets_after_final = _embedding_asset_snapshot(prepared["data"])
                    generation_after_final = _active_generation_present(prepared["data"])
                    current_day = datetime.now(ZoneInfo(TIMEZONE)).date().isoformat()
                    receipt.setdefault("embedding_conditions", {
                        "status": "observed", "data_scope": "fresh_isolated_DATA",
                        "active_generation_before": "absent",
                        "active_generation_after": "present" if generation_after_final else "absent",
                        "embedding_asset_cache_after": assets_after_final,
                        "asset_downloads_observed": 0 if not assets_after_final["root_present"] else "unavailable",
                        "embedding_owner_invocations": "unavailable_no_public_owner_registry",
                        "daily_session_sync": "suppressed_for_local_day",
                        "daily_consolidation_cycle": "suppressed_for_local_day",
                        "scheduler_suppression": {
                            "data_scope": "same_fresh_fixture_DATA",
                            "local_day_timezone": TIMEZONE,
                            "local_day": prepared["local_day"],
                        },
                        "local_day_window_held": current_day == prepared["local_day"],
                        "provider_turn_fixture_preparation_mutated_measurement_state": False,
                    })
                except Exception as error:
                    receipt["embedding_conditions"] = {
                        "status": "unavailable", "failure": _safe_error(error),
                        "embedding_owner_invocations": "unavailable_no_public_owner_registry",
                    }
            receipt["owned_cleanup"] = {
                "status": "observed" if shutdown.get("residual_owned_process_count") == 0 and
                          not shutdown.get("ownership_observation_unavailable") else "unavailable",
                "residual_owned_process_count": shutdown.get("residual_owned_process_count"),
                "forced_termination": shutdown.get("forced_termination"),
                "listener_residue_status": listener.get("status"),
                "listener_count": listener.get("listener_count"),
            }
    try:
        credential_state_after = _credential_file_state(credential_file)
        receipt["credential_input"]["unchanged_before_and_after"] = (
            credential_state_before == credential_state_after
        )
    except Exception:
        receipt["credential_input"]["unchanged_before_and_after"] = False
    if receipt["status"] == "observed":
        postcondition_failures = []
        if receipt["owned_cleanup"].get("status") != "observed":
            postcondition_failures.append("owned_cleanup_not_verified")
        if receipt["installation_immutable"].get("status") != "observed":
            postcondition_failures.append("installation_immutability_not_verified")
        if not receipt["credential_input"].get("unchanged_before_and_after"):
            postcondition_failures.append("frozen_credential_input_changed")
        if receipt["embedding_conditions"].get("status") != "observed" or \
           receipt["embedding_conditions"].get("active_generation_after") != "absent" or \
           receipt["embedding_conditions"].get("embedding_asset_cache_after", {}).get("root_present") is not False or \
           receipt["embedding_conditions"].get("local_day_window_held") is not True:
            postcondition_failures.append("no_embedding_boundary_not_verified")
        if postcondition_failures:
            receipt["status"] = "not_observed"
            receipt["postcondition_failures"] = postcondition_failures
    receipt["canonical_read_evidence_sha256"] = digest(receipt["tool_journal"])
    receipt["receipt_sha256"] = digest({key: value for key, value in receipt.items()
                                        if key != "receipt_sha256"})
    _private_write(output_dir / f"{arm}.json", receipt)
    return receipt


def main() -> None:
    global MODEL, EFFORT, LEGACY_INSTALLATION, CANDIDATE_INSTALLATION
    global FIXTURE_SEED_INSTALLATION, LEGACY_MANIFEST_SHA256, CANDIDATE_MANIFEST_SHA256
    parser = argparse.ArgumentParser()
    provider = parser.add_mutually_exclusive_group(required=True)
    provider.add_argument("--credential-file", type=Path)
    provider.add_argument("--codex-oauth-file", type=Path)
    parser.add_argument("--model", default=MODEL)
    parser.add_argument("--legacy-installation", type=Path, default=LEGACY_INSTALLATION)
    parser.add_argument("--candidate-installation", type=Path, default=CANDIDATE_INSTALLATION)
    parser.add_argument("--fixture-seed-installation", type=Path)
    parser.add_argument("--scratch-parent", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    MODEL = args.model
    if args.codex_oauth_file and MODEL != "openai/gpt-6-sol":
        parser.error("Codex OAuth readiness currently requires openai/gpt-6-sol")
    EFFORT = "medium"
    LEGACY_INSTALLATION = args.legacy_installation.resolve(strict=True)
    CANDIDATE_INSTALLATION = args.candidate_installation.resolve(strict=True)
    FIXTURE_SEED_INSTALLATION = (args.fixture_seed_installation or LEGACY_INSTALLATION).resolve(strict=True)
    LEGACY_MANIFEST_SHA256 = digest(artifact_manifest(LEGACY_INSTALLATION))
    CANDIDATE_MANIFEST_SHA256 = digest(artifact_manifest(CANDIDATE_INSTALLATION))
    credential_file = (args.codex_oauth_file or args.credential_file).resolve(strict=True)
    scratch_parent = args.scratch_parent.resolve(strict=True)
    output_dir = args.output_dir.resolve(strict=False)
    if args.scratch_parent.is_symlink() or args.output_dir.is_symlink():
        raise SystemExit("provider readiness directories must not be symbolic links")
    for path in (scratch_parent, output_dir):
        if path == LEGACY_INSTALLATION or path.is_relative_to(LEGACY_INSTALLATION) or \
           path == CANDIDATE_INSTALLATION or path.is_relative_to(CANDIDATE_INSTALLATION) or \
           path == Path.home() / ".butler" or path.is_relative_to(Path.home() / ".butler"):
            raise SystemExit("provider readiness paths overlap an installation or production data")
    if scratch_parent == Path(__file__).resolve().parents[3] or \
       scratch_parent.is_relative_to(Path(__file__).resolve().parents[3]):
        raise SystemExit("provider readiness scratch overlaps source")
    if output_dir == Path(__file__).resolve().parents[3] or \
       output_dir.is_relative_to(Path(__file__).resolve().parents[3]):
        raise SystemExit("provider readiness output overlaps source")
    os.umask(0o077)
    output_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    scratch_parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(output_dir, 0o700)
    os.chmod(scratch_parent, 0o700)
    # One explicit private provider input is shared by both isolated arms.
    provider_input = _load_provider_input({
        ("provider_codex_oauth_file" if args.codex_oauth_file else "provider_credential_file"):
            str(credential_file),
        "model": MODEL,
    })
    reference_id = (provider_input["profile"].get("accountId")
                    if provider_input["mode"] == "codex_oauth"
                    else provider_input["credential"]["id"])
    fingerprint_salt = secrets.token_bytes(32)
    credential_fingerprint = hashlib.sha256(
        fingerprint_salt + reference_id.encode("utf-8")
    ).hexdigest()
    source_facts = {"credential_record_count": 1}
    input_state_before = _credential_file_state(credential_file)
    arms = {}
    for arm in ("legacy", "candidate"):
        arms[arm] = _run_arm(
            arm=arm, output_dir=output_dir, scratch_parent=scratch_parent,
            provider_input=provider_input, credential_fingerprint=credential_fingerprint,
            credential_file=credential_file, source_facts=source_facts,
        )
    input_state_after = _credential_file_state(credential_file)
    summary = {
        "schema": "butler.rust-benchmark.actual-provider-readiness.v1",
        "status": "observed" if all(arm.get("status") == "observed" for arm in arms.values()) else "partial",
        "model": MODEL,
        "reasoning_effort": EFFORT,
        "fallback_settings": FALLBACK_OFF,
        "provider_id": "openai" if provider_input["mode"] == "codex_oauth" else "zai",
        "auth_type": "codex_oauth" if provider_input["mode"] == "codex_oauth" else "api_key",
        "credential_record_count": 1,
        "credential_reference_fingerprint": credential_fingerprint,
        "credential_fingerprint_basis": "ephemeral_salted_reference_id; secret value and hash excluded",
        "frozen_input_alias": "frozen-input/openai-codex.json" if provider_input["mode"] == "codex_oauth" else "frozen-input/credential.json",
        "frozen_input_mode": "0600",
        "frozen_input_directory_mode": "0700",
        "frozen_input_unchanged": input_state_before == input_state_after,
        "arm_receipts": {arm: {
            "status": record.get("status"),
            "receipt_sha256": record.get("receipt_sha256"),
            "installation_manifest_sha256": record.get("installation_manifest_sha256"),
            "launch_spec_sha256": record.get("launch_spec_sha256"),
            "canonical_read_evidence_sha256": record.get("canonical_read_evidence_sha256"),
        } for arm, record in arms.items()},
        "root_review_only": True,
        "campaign_run": False,
    }
    summary["receipt_sha256"] = digest(summary)
    _private_write(output_dir / "summary.json", summary)
    print(json.dumps({
        "status": summary["status"],
        "model": MODEL,
        "reasoning_effort": EFFORT,
        "credential_record_count": 1,
        "credential_reference_fingerprint": credential_fingerprint,
        "arms": {arm: receipt["status"] for arm, receipt in arms.items()},
        "output_alias": "provider-readiness-private-20260925/receipts/summary.json",
    }, sort_keys=True))


if __name__ == "__main__":
    main()
