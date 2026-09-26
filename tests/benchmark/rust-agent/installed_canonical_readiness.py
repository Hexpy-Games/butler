"""Exercise installed Guided Turn canonical reads through a loopback model."""

from __future__ import annotations

import argparse
from datetime import datetime
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import time
import uuid
from typing import Any
from zoneinfo import ZoneInfo

from app_protocol import AppClient, AppProtocolError
from launch import OwnedLaunch, artifact_manifest
from readiness import digest, expected_canonical_reads
from run_campaign import (
    _active_generation_present,
    _commands,
    _digest,
    _embedding_asset_snapshot,
    _fixture_procedure_sha256,
    _make_env,
    _allocate_port,
    BUN_PATH,
    _port_still_free,
    PRODUCTION_DATA,
    REPO,
    _prepare_arm,
    _suppress_daily_memory_jobs,
    _wait_ready as campaign_wait_ready,
    _new_private_file,
    verify_artifact_unchanged,
)
from tool_evidence import inspect_canonical_read_journal, inspect_tool_journal
from turn_observer import observe_turn
from workload import load_workload


FINAL_TEXT = "F1-F7 canonical reads completed through the installed public tools."
FALLBACK_OFF = {"enabled": False, "models": []}
LEGACY_STORAGE_PREPARATION_MODULE = Path(
    "/packages/butler-agent/src/operations/service/native-service-storage-preparation.ts"
)
LEGACY_STORAGE_DAEMON_MODULE = Path(
    "/packages/butler-agent/src/operations/service/native-service-daemon.ts"
)
LEGACY_SUPERVISOR_MODULE = Path(
    "/packages/butler-agent/src/operations/service/native-service-supervisor.ts"
)


def _json_digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
                               ensure_ascii=False).encode("utf-8")).hexdigest()


def _tool_result(body: dict[str, Any]) -> dict[str, Any]:
    outputs = [item for item in body.get("input", [])
               if isinstance(item, dict) and item.get("type") == "function_call_output"]
    if not outputs or not isinstance(outputs[-1].get("output"), str):
        raise ValueError("guided_tool_output_missing")
    try:
        outer = json.loads(outputs[-1]["output"])
    except (ValueError, TypeError):
        raise ValueError("guided_tool_output_invalid") from None
    if not isinstance(outer, dict) or outer.get("ok") is not True:
        raise ValueError("guided_tool_result_failed")
    value = outer.get("output")
    if isinstance(value, dict):
        return value
    raise ValueError("guided_tool_result_missing")


def _walk(value: Any):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from _walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from _walk(child)


def _query_match(result: dict[str, Any], source: dict[str, Any]) -> dict[str, Any]:
    for node in _walk(result):
        rows = node.get("results")
        if node.get("ok") is True and node.get("status") == "complete" and isinstance(rows, list):
            matches = [row for row in rows if isinstance(row, dict) and
                       row.get("conversation_message_id") == source["message_id"] and
                       row.get("source") == "conversation-store"]
            if len(matches) == 1:
                row = matches[0]
                read_args = row.get("read_args")
                if isinstance(read_args, dict) and \
                   str(read_args.get("source_ref", "")).startswith("conversation-source:v2:"):
                    return {"row": row, "read_args": read_args}
    raise ValueError("canonical_query_result_mismatch")


def _read_match(result: dict[str, Any], source: dict[str, Any]) -> None:
    for node in _walk(result):
        message_id = node.get("conversation_message_id", node.get("read_message_id"))
        if node.get("ok") is True and node.get("status") == "complete" and \
           message_id == source["message_id"] and node.get("text") == source["text"]:
            return
    raise ValueError("canonical_source_read_mismatch")


def _prepare_frozen_legacy_storage(installation_root: Path, prepared: dict[str, Any],
                                  timezone: str) -> dict[str, Any]:
    """Run the frozen legacy daemon's exact isolated storage preparation before its owners."""
    preparation_module = installation_root / LEGACY_STORAGE_PREPARATION_MODULE.relative_to("/")
    daemon_module = installation_root / LEGACY_STORAGE_DAEMON_MODULE.relative_to("/")
    for module in (preparation_module, daemon_module):
        if not module.is_file():
            raise FileNotFoundError("frozen_legacy_storage_preparation_source_missing")
    data = prepared["data"]
    legacy_app_db = data / "app-server" / "butler-client.sqlite"
    if legacy_app_db.exists():
        raise ValueError("legacy_storage_preparation_requires_fresh_empty_app_database")
    script = prepared["arm"] / "prepare-frozen-legacy-storage.ts"
    import_target = str(preparation_module).replace("\\", "\\\\").replace('"', '\\"')
    script.write_text(
        'import { prepareAgentStorageForNativeServiceLaunch } from "' +
        import_target + '";\n' +
        'const butlerData = process.argv[2];\n' +
        'await prepareAgentStorageForNativeServiceLaunch({ butlerData, runtimeVersion: "native-service-split-v1", quiesceLegacyWriter: async () => {} });\n' +
        'process.stdout.write(JSON.stringify({ status: "prepared_and_activated", route: "frozen-native-service-storage-preparation", runtime_version: "native-service-split-v1" }) + "\\n");\n',
        encoding="utf-8",
    )
    os.chmod(script, 0o600)
    environment = {key: value for key, value in os.environ.items()
                   if key in {"PATH", "LANG", "LC_ALL", "SYSTEMROOT"}}
    environment.update({"HOME": str(prepared["arm"] / "home"),
                        "BUTLER_DATA": str(data), "TZ": timezone})
    started_ns = time.perf_counter_ns()
    completed = subprocess.run([str(BUN_PATH), str(script), str(data)],
                               check=True, capture_output=True, env=environment, timeout=60)
    duration_ms = (time.perf_counter_ns() - started_ns) / 1_000_000
    try:
        output = json.loads(completed.stdout)
    except (ValueError, TypeError):
        raise RuntimeError("frozen_legacy_storage_preparation_receipt_invalid") from None
    if not isinstance(output, dict) or output.get("status") != "prepared_and_activated":
        raise RuntimeError("frozen_legacy_storage_preparation_not_confirmed")
    return {
        **output,
        "source_module": str(preparation_module.relative_to(installation_root)),
        "source_module_sha256": hashlib.sha256(preparation_module.read_bytes()).hexdigest(),
        "invoker_module": str(daemon_module.relative_to(installation_root)),
        "invoker_module_sha256": hashlib.sha256(daemon_module.read_bytes()).hexdigest(),
        "legacy_app_database_present_before": False,
        "agent_storage_source_kind": "fresh_install",
        "duration_ms": duration_ms,
        "preparation_cost_included_in_readiness_boot": False,
        "isolated_data_root": "per-arm-temporary-data",
    }


class _FixtureProvider:
    def __init__(self, workload: dict[str, Any], model_id: str):
        self.workload = workload
        self.model_id = model_id
        self.index = 0
        self.awaiting: str | None = None
        self.read_args: dict[str, Any] | None = None
        self.evidence: list[dict[str, Any]] = []
        self.normal_request_count = 0
        self.structured_request_count = 0
        self.post_fixture_synthesis_request_count = 0
        self.errors: list[str] = []
        self._lock = threading.Lock()

    def _message_meaning_request(self, body: dict[str, Any]) -> bool:
        text = body.get("text")
        return isinstance(text, dict) and \
            str(text.get("format", {}).get("name", "")).startswith("memory_meaning")

    def _consume_result(self, body: dict[str, Any]) -> tuple[str, dict[str, Any] | None]:
        result = _tool_result(body)
        source = self.workload["sources"][self.index]
        if self.awaiting == "query_memory":
            match = _query_match(result, source)
            self.read_args = match["read_args"]
            return "read_conversation_session", self.read_args
        if self.awaiting == "read_conversation_session":
            _read_match(result, source)
            self.evidence.append({
                "fixture_id": source["id"],
                "source_message_id": source["message_id"],
                "query_memory": "completed",
                "query_source": "conversation-store",
                "read_conversation_session": "completed",
                "read_message_id": source["message_id"],
                "read_text_sha256": hashlib.sha256(source["text"].encode("utf-8")).hexdigest(),
                "read_args_sha256": _json_digest(self.read_args),
            })
            self.index += 1
            self.read_args = None
            if self.index == len(self.workload["sources"]):
                self.awaiting = None
                return "final", None
            return "query_memory", self._query_args(self.workload["sources"][self.index])
        raise ValueError("unexpected_guided_tool_result")

    @staticmethod
    def _query_args(source: dict[str, Any]) -> dict[str, Any]:
        return {"query": source["text"], "scope": "all_user_sessions", "speaker": "user",
                "match_mode": "phrase", "order": "earliest", "limit": 50}

    def handle(self, handler: BaseHTTPRequestHandler) -> None:
        try:
            if handler.path != "/v1/responses":
                raise ValueError("unexpected_loopback_model_route")
            size = int(handler.headers.get("Content-Length", "0"))
            if size < 1 or size > 8_000_000:
                raise ValueError("loopback_model_request_size_invalid")
            body = json.loads(handler.rfile.read(size))
            if not isinstance(body, dict):
                raise ValueError("loopback_model_request_invalid")
            if self._message_meaning_request(body):
                self.structured_request_count += 1
                output = [{"type": "message", "content": [{"type": "output_text", "text": json.dumps({
                    "status": "processed", "entities": [], "items": [], "attributes": []})}]}]
            else:
                with self._lock:
                    if body.get("model") != self.model_id:
                        raise ValueError("unexpected_loopback_model_id")
                    if self.normal_request_count >= 32:
                        raise ValueError("loopback_tool_round_limit")
                    self.normal_request_count += 1
                    sequence_complete = self.index >= len(self.workload["sources"]) and \
                        self.awaiting is None
                    if sequence_complete:
                        # The installed turn can make additional synthesis requests after the
                        # final tool result. They need no recall tools and must not count as
                        # canonical tool invocations.
                        self.post_fixture_synthesis_request_count += 1
                        name, arguments = "final", None
                    else:
                        tool_names = {item.get("name") for item in body.get("tools", [])
                                      if isinstance(item, dict)}
                        if not {"query_memory", "read_conversation_session"}.issubset(tool_names):
                            raise ValueError("installed_guided_read_tools_unavailable")
                        if self.awaiting is None:
                            name = "query_memory"
                            arguments = self._query_args(self.workload["sources"][self.index])
                        else:
                            name, arguments = self._consume_result(body)
                    if name == "final":
                        output = [{"type": "message", "content": [{"type": "output_text",
                                                                        "text": FINAL_TEXT}]}]
                    else:
                        call_index = len(self.evidence) * 2 + (1 if name == "read_conversation_session" else 0)
                        call_id = f"rust-ready-{self.index + 1}-{name}-{call_index}"
                        self.awaiting = name
                        output = [{"type": "function_call", "call_id": call_id, "name": name,
                                   "arguments": json.dumps(arguments, ensure_ascii=False)}]
            response = {"id": f"rust-readiness-{self.normal_request_count}-{uuid.uuid4().hex[:8]}",
                        "model": self.model_id, "output": output}
            status = 200
        except Exception as error:
            # Keep private provider payloads and canonical text out of logs/evidence.
            self.errors.append(type(error).__name__ + ":" + str(error).split(":", 1)[0])
            response = {"error": {"message": "isolated canonical-read probe rejected the request"}}
            status = 400
        raw = json.dumps(response).encode("utf-8")
        handler.send_response(status)
        handler.send_header("Content-Type", "application/json")
        handler.send_header("Content-Length", str(len(raw)))
        handler.end_headers()
        handler.wfile.write(raw)


def _provider_handler(provider: _FixtureProvider):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args: Any) -> None:
            pass

        def do_POST(self) -> None:
            provider.handle(self)

    return Handler


def run_probe(*, arm: str, installation_root: Path, command_templates: list[list[str]],
              expected_manifest_sha256: str, fixture_seed_root: Path,
              expected_fixture_seed_manifest_sha256: str,
              campaign_model: str, campaign_reasoning_effort: str,
              loopback_model: str, loopback_reasoning_effort: str, timezone: str, locale: str,
              scratch_parent: Path, failure_output: Path | None = None) -> dict[str, Any]:
    if arm not in {"legacy", "candidate"}:
        raise ValueError("arm must be legacy or candidate")
    if loopback_model != "openai/gpt-5.5" or not loopback_reasoning_effort:
        raise ValueError("explicit OpenAI loopback model and reasoning effort are required")
    if not campaign_model or "/" not in campaign_model or not campaign_reasoning_effort:
        raise ValueError("explicit campaign model and reasoning effort are required")
    installation_root = installation_root.resolve(strict=True)
    fixture_seed_root = fixture_seed_root.resolve(strict=True)
    if scratch_parent.is_symlink():
        raise ValueError("readiness scratch parent must not be a symbolic link")
    scratch_parent = scratch_parent.resolve(strict=True)
    production_roots = [PRODUCTION_DATA.resolve(strict=False), Path.home() / ".butler"]
    configured_data = os.environ.get("BUTLER_DATA")
    if configured_data:
        production_roots.append(Path(configured_data).expanduser().resolve(strict=False))
    production_roots = [path.resolve(strict=False) for path in production_roots]
    if scratch_parent == REPO or scratch_parent.is_relative_to(REPO) or any(
        scratch_parent == path or scratch_parent.is_relative_to(path) for path in production_roots
    ) or \
       scratch_parent == installation_root or scratch_parent.is_relative_to(installation_root):
        raise ValueError("readiness scratch overlaps production DATA or installation")
    if scratch_parent == fixture_seed_root or scratch_parent.is_relative_to(fixture_seed_root):
        raise ValueError("readiness scratch overlaps fixture seed installation")
    installation_manifest = artifact_manifest(installation_root)
    manifest_hash = _digest(installation_manifest)
    if manifest_hash != expected_manifest_sha256:
        raise ValueError("installed_artifact_manifest_mismatch")
    fixture_seed_manifest = artifact_manifest(fixture_seed_root)
    fixture_seed_manifest_hash = _digest(fixture_seed_manifest)
    if fixture_seed_manifest_hash != expected_fixture_seed_manifest_sha256:
        raise ValueError("fixture_seed_installation_manifest_mismatch")
    fixture_seed_source_root = fixture_seed_root / "packages" / "butler-agent" / "src"
    fixture_seed_files = [
        fixture_seed_source_root / "agent" / "conversation" / "store.ts",
        fixture_seed_source_root / "agent" / "conversation" / "session-admission.ts",
    ]
    if any(not path.is_file() for path in fixture_seed_files):
        raise FileNotFoundError("fixture_seed_source_files_missing")
    if (arm == "legacy" and len(command_templates) != 2) or \
       (arm == "candidate" and len(command_templates) != 1):
        raise ValueError("installed_launch_command_count_invalid")
    command_sha = _digest({"commands": command_templates})
    if arm == "legacy":
        command_markers = ["native-butler-main.ts" in " ".join(command)
                           for command in command_templates]
        app_markers = ["app-gateway-cli.ts" in " ".join(command)
                       for command in command_templates]
        if command_markers != [True, False] or app_markers != [False, True]:
            raise ValueError("legacy_launch_order_must_follow_frozen_daemon_main_then_gateway")
    workload = load_workload()
    expected_sources = expected_canonical_reads(workload)
    if len(expected_sources) != 7:
        raise ValueError("canonical_fixture_count_invalid")

    with tempfile.TemporaryDirectory(prefix=f"butler-readiness-{arm}-", dir=scratch_parent) as temporary:
        pair_root = Path(temporary)
        try:
            prepared = _prepare_arm(
                pair_root, arm, timezone,
                fixture_source_root=fixture_seed_source_root,
            )
        except subprocess.CalledProcessError as error:
            stderr = (error.stderr or b"").decode("utf-8", "replace")[:512]
            stdout = (error.stdout or b"").decode("utf-8", "replace")[:512]
            for secret in (str(pair_root), str(pair_root / arm / "data"),
                           str(pair_root / arm / "workspace")):
                stderr = stderr.replace(secret, "<redacted>")
                stdout = stdout.replace(secret, "<redacted>")
            raise RuntimeError(json.dumps({
                "failure": "isolated_canonical_fixture_seed_failed",
                "exit_code": error.returncode,
                "stdout": stdout,
                "stderr": stderr,
            }, sort_keys=True)) from None
        config = prepared["config"]
        config["system"]["defaultModel"] = campaign_model
        config["system"]["butlerModel"] = campaign_model
        config["system"]["openaiReasoningEffort"] = campaign_reasoning_effort
        config["user"]["modelFallback"] = FALLBACK_OFF.copy()
        _new_config = prepared["data"] / "butler.config.json"
        _new_private_file(_new_config, json.dumps(config).encode("utf-8"))
        port = _allocate_port()
        if not _port_still_free(port):
            raise RuntimeError("app_port_race_before_spawn")
        auth_token = prepared["auth_token"]
        prepared["port"] = port
        prepared["local_day"] = _suppress_daily_memory_jobs(prepared["data"], timezone)
        generation_before = _active_generation_present(prepared["data"])
        assets_before = _embedding_asset_snapshot(prepared["data"])
        if generation_before or assets_before["root_present"]:
            raise ValueError("fresh_installed_readiness_DATA_not_empty")
        storage_preparation = (
            _prepare_frozen_legacy_storage(installation_root, prepared, timezone)
            if arm == "legacy" else {
                "status": "not_performed",
                "route": "candidate-service-run-owner-is-responsible",
                "preparation_cost_included_in_readiness_boot": True,
            }
        )
        agent_db_path = prepared["data"] / "agent-runtime" / "btcc.sqlite"
        storage_preparation["agent_database_present_before_owner_launch"] = agent_db_path.is_file()

        provider_state = _FixtureProvider(workload, loopback_model.partition("/")[2])
        provider = ThreadingHTTPServer(("127.0.0.1", 0), _provider_handler(provider_state))
        provider_thread = threading.Thread(target=provider.serve_forever, daemon=True)
        provider_thread.start()
        endpoint = f"http://127.0.0.1:{provider.server_port}/v1"
        env = _make_env(prepared, arm, {
                            "timezone": timezone,
                            "locale": locale,
                            "legacy": {"installation_root": str(installation_root)},
                        },
                        {"mode": "environment", "environment": {}})
        env.update({
            "BUTLER_COGNITION_ROOT": str(prepared["data"] / "cognition"),
            "BUTLER_COGNITION_HOME": str(prepared["data"] / "cognition"),
            "BUTLER_COGNITION_MEMORY_HOME": str(prepared["data"] / "cognition" / "memory"),
            "OPENAI_API_KEY": "isolated-loopback-only",
            "OPENAI_BASE_URL": endpoint,
            "BUTLER_ZAI_BASE_URL": endpoint,
            "BUTLER_MODEL_API_RETRY_ATTEMPTS": "1",
            "BUTLER_MODEL_API_RETRY_DELAY_MS": "0",
            "GIT_CONFIG_GLOBAL": "/dev/null",
            "GIT_CONFIG_NOSYSTEM": "1",
        })
        command_spec = {"installation_root": str(installation_root),
                        "commands": command_templates}
        commands = _commands(command_spec, prepared)
        launch = OwnedLaunch(commands, prepared["workspace"], env,
                             prepared["evidence"] / "backend-logs")
        shutdown: dict[str, Any] = {}
        roots: tuple[Any, ...] = ()
        try:
            roots = launch.start()
            client = AppClient(f"http://127.0.0.1:{port}", auth_token, timeout_s=10)
            try:
                campaign_wait_ready(client, set(roots), deadline_s=90)
            except RuntimeError as error:
                # Keep only fixed-category startup diagnostics; backend output
                # can contain configuration details and must not enter receipts.
                signatures = ("error", "failed", "not found", "permission", "panic",
                              "listening", "ready", "address already in use")
                backend_diagnostics = []
                for index, process in enumerate(launch.processes):
                    log_path = launch.log_directory / f"backend-{index}.log"
                    raw = log_path.read_bytes() if log_path.exists() else b""
                    lowered = raw.decode("utf-8", "replace").lower()
                    excerpt = raw.decode("utf-8", "replace")[:512]
                    for secret in (auth_token, prepared["folder_secret"],
                                   "isolated-loopback-only", str(pair_root),
                                   str(prepared["data"]), str(prepared["workspace"])):
                        excerpt = excerpt.replace(secret, "<redacted>")
                    backend_diagnostics.append({
                        "exit_code": process.poll(),
                        "log_bytes": len(raw),
                        "log_sha256": hashlib.sha256(raw).hexdigest(),
                        "matched_categories": [word for word in signatures if word in lowered],
                        "sanitized_excerpt": excerpt,
                    })
                raise RuntimeError(json.dumps({"readiness": str(error),
                                               "backend_diagnostics": backend_diagnostics},
                                              sort_keys=True)) from None
            settings_update = client.update_model_settings(campaign_model, campaign_reasoning_effort)
            if settings_update.data.get("model") != campaign_model or \
               settings_update.data.get("reasoning_effort") != campaign_reasoning_effort:
                raise RuntimeError("installed_public_campaign_settings_update_mismatch")
            settings = client.settings().data
            actual_fallback = settings.get("model_fallback")
            if settings.get("model") != campaign_model or \
               settings.get("reasoning_effort") != campaign_reasoning_effort or \
               actual_fallback != FALLBACK_OFF:
                raise RuntimeError(json.dumps({
                    "failure": "installed_campaign_settings_mismatch",
                    "requested_model": campaign_model,
                    "requested_reasoning_effort": campaign_reasoning_effort,
                    "observed_model": settings.get("model"),
                    "observed_reasoning_effort": settings.get("reasoning_effort"),
                    "observed_fallback_settings": actual_fallback,
                }, sort_keys=True))
            created = client.create_readiness_session("rust-readiness-" + uuid.uuid4().hex)
            session = created.data.get("session")
            if not isinstance(session, dict) or not isinstance(session.get("id"), str):
                raise AppProtocolError("readiness_session_creation_failed")
            try:
                observed = observe_turn(
                    client,
                    session_id=session["id"],
                    client_message_id="rust-readiness-" + uuid.uuid4().hex,
                    prompt="Use query_memory and read_conversation_session on each of the seven isolated source facts, in order. Pass each returned read_args unchanged. Then confirm completion.",
                    model=loopback_model,
                    reasoning_effort=loopback_reasoning_effort,
                    deadline_s=240,
                )
            except AppProtocolError as error:
                if error.code != "event_cursor_invalid":
                    raise
                page = client._request("GET", "/events?cursor=0&limit=200").data
                events = page.get("events")
                raise RuntimeError(json.dumps({
                    "failure": error.code,
                    "harness_expected": {
                        "events_type": "list",
                        "next_cursor_type": "int",
                    },
                    "installed_public_response_shape": {
                        "keys": sorted(page.keys()),
                        "events_type": type(events).__name__,
                        "events_count": len(events) if isinstance(events, list) else None,
                        "first_event_keys": sorted(events[0].keys())
                        if isinstance(events, list) and events and isinstance(events[0], dict) else None,
                        "next_cursor_type": type(page.get("next_cursor")).__name__,
                        "cursor_type": type(page.get("cursor")).__name__,
                    },
                }, sort_keys=True)) from None
            if observed.terminal_state != "delivered" or observed.final_text != FINAL_TEXT:
                raise RuntimeError("installed_public_readiness_turn_incomplete")
            if provider_state.errors or provider_state.index != len(workload["sources"]) or \
               len(provider_state.evidence) != len(expected_sources):
                journal = inspect_tool_journal(
                    prepared["data"], observed.turn_id,
                    {source["message_id"] for source in workload["sources"]},
                    {"query_memory", "read_conversation_session"},
                )
                failure = {
                    "schema": "butler.rust-benchmark.loopback-failure.v1",
                    "status": "not_observed",
                    "arm": arm,
                    "failure": "loopback_tool_sequence_incomplete",
                    "installation_manifest_sha256": manifest_hash,
                    "launch_spec_sha256": command_sha,
                    "loopback_public_turn": {
                        "transport": "isolated_loopback_openai_responses",
                        "model": loopback_model,
                        "reasoning_effort": loopback_reasoning_effort,
                        "terminal_state": observed.terminal_state,
                        "final_text_matched": observed.final_text == FINAL_TEXT,
                        "provider_requests": provider_state.normal_request_count,
                        "expected_provider_requests": 2 * len(expected_sources) + 1,
                        "structured_requests": provider_state.structured_request_count,
                        "provider_error_codes": list(provider_state.errors),
                        "fixture_pairs_expected": len(expected_sources),
                        "fixture_pairs_completed": provider_state.index,
                        "successful_pair_evidence_count": len(provider_state.evidence),
                        "next_expected_tool": provider_state.awaiting,
                    },
                    "tool_journal_readback": journal,
                }
                if failure_output is not None:
                    _write_private(failure_output, failure)
                raise RuntimeError("loopback_tool_sequence_incomplete")
            if provider_state.normal_request_count < 2 * len(expected_sources) + 1:
                raise RuntimeError("loopback_tool_round_count_mismatch")
            journal = inspect_canonical_read_journal(
                prepared["data"], observed.turn_id, workload["sources"],
                expected_sources,
            )
            if journal.get("status") != "observed" or journal.get("canonical_reads_complete") is not True:
                raise RuntimeError("installed_guided_tool_journal_incomplete")
            if journal.get("sources") != provider_state.evidence:
                raise RuntimeError("provider_and_journal_evidence_mismatch")
            storage_preparation["agent_database_present_after_public_readiness"] = agent_db_path.is_file()
            storage_preparation["public_owner_readiness_validated"] = True
            generation_after = _active_generation_present(prepared["data"])
            assets_after = _embedding_asset_snapshot(prepared["data"])
            local_day_after = datetime.now(ZoneInfo(timezone)).date().isoformat()
            if generation_after or assets_after["root_present"] or local_day_after != prepared["local_day"]:
                raise RuntimeError("installed_readiness_embedding_boundary_changed")
            verify_artifact_unchanged(installation_root, installation_manifest)
            verify_artifact_unchanged(fixture_seed_root, fixture_seed_manifest)
            canonical = {
                "schema": "butler.rust-benchmark.canonical-read.v2",
                "status": "observed",
                "verification_route": "installed-public-guided-turn-journal",
                "installation_manifest_sha256": manifest_hash,
                "launch_spec_sha256": command_sha,
                "lookup_tool": "query_memory",
                "source_read_tool": "read_conversation_session",
                "api_surface": "installed-public-guided-turn",
                "effective_campaign_model_configuration": {
                    "model": settings["model"],
                    "reasoning_effort": settings["reasoning_effort"],
                    "fallback_settings": actual_fallback,
                    "source": "authenticated_public_settings_patch_then_read",
                },
                "public_campaign_settings_update": {
                    "status": "observed",
                    "model": campaign_model,
                    "reasoning_effort": campaign_reasoning_effort,
                },
                "loopback_public_turn": {
                    "status": "observed",
                    "model": loopback_model,
                    "reasoning_effort": loopback_reasoning_effort,
                    "transport": "isolated_loopback_openai_responses",
                    "endpoint_host": "127.0.0.1",
                    "provider_requests": (provider_state.normal_request_count +
                                          provider_state.structured_request_count),
                    "guided_tool_invocations": journal["tool_invocation_count"],
                    "post_fixture_synthesis_requests":
                        provider_state.post_fixture_synthesis_request_count,
                    "provider_state_reset_scope": (
                        "in-memory post-fixture awaiting-tool marker only; "
                        "canonical fixture and benchmark measurement state unchanged"
                    ),
                    "terminal_state": observed.terminal_state,
                },
                "journal_readback": journal,
                "active_generation_before": "absent",
                "active_generation_after": "absent",
                "embedding_asset_cache_before": "absent",
                "embedding_asset_cache_after": "absent",
                "daily_session_sync": "suppressed_for_local_day",
                "daily_consolidation_cycle": "suppressed_for_local_day",
                "local_day_window_held": True,
                "sources": expected_sources,
            }
            result = {
                "schema": "butler.rust-benchmark.installed-readiness.v1",
                "arm": arm,
                "status": "observed",
                "installation_manifest_sha256": manifest_hash,
                "launch_spec_sha256": command_sha,
                "launch_order_evidence": ({
                    "status": "source_mapped",
                    "observed_order": ["butler-main", "app-gateway"],
                    "source_order": ["butler-main", "app-gateway"],
                    "daemon_start_all_behavior": "sequential_spec_spawn_order",
                    "supervisor_source": str((installation_root / LEGACY_SUPERVISOR_MODULE.relative_to("/")).relative_to(installation_root)),
                    "supervisor_source_sha256": hashlib.sha256(
                        (installation_root / LEGACY_SUPERVISOR_MODULE.relative_to("/")).read_bytes()
                    ).hexdigest(),
                    "daemon_source": str((installation_root / LEGACY_STORAGE_DAEMON_MODULE.relative_to("/")).relative_to(installation_root)),
                    "daemon_source_sha256": hashlib.sha256(
                        (installation_root / LEGACY_STORAGE_DAEMON_MODULE.relative_to("/")).read_bytes()
                    ).hexdigest(),
                } if arm == "legacy" else {
                    "status": "single_candidate_owner",
                    "observed_order": ["candidate-service-run"],
                    "source_order": "not_applicable",
                }),
                "fixture_procedure_sha256": _fixture_procedure_sha256(),
                "canonical_fixture_seed": {
                    "status": "prepared_not_observed",
                    "route": "shared-frozen-legacy-AgentConversationStore",
                    "installation_manifest_sha256": fixture_seed_manifest_hash,
                    "source_root": "packages/butler-agent/src",
                    "source_files": [
                        {
                            "path": str(path.relative_to(fixture_seed_root)),
                            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                        }
                        for path in fixture_seed_files
                    ],
                    "fixture_source_count": len(expected_sources),
                    "seed_is_not_installed_read_evidence": True,
                },
                "model": campaign_model,
                "reasoning_effort": campaign_reasoning_effort,
                "fallback_settings": FALLBACK_OFF,
                "storage_preparation": storage_preparation,
                "readiness_boot_timing_scope": (
                    "after_frozen_storage_preparation"
                    if arm == "legacy" else "candidate_owner_start_includes_storage_initialization"
                ),
                "canonical_read_evidence": canonical,
                "canonical_read_evidence_sha256": digest(canonical),
                "embedding_owner_conditions": {
                    "active_generation": "absent",
                    "exact_lookup_and_read_only": True,
                    "recall_resolves_generation_before_embedding": True,
                    "daily_session_sync": "suppressed_for_local_day",
                    "daily_consolidation_cycle": "suppressed_for_local_day",
                    "asset_downloads_observed": 0,
                    "embedding_owner_invocations": "unavailable_no_public_owner_registry",
                },
            }
        finally:
            if roots:
                shutdown = launch.shutdown(set(roots))
            provider.shutdown()
            provider.server_close()
            provider_thread.join(timeout=2)
        if shutdown.get("residual_owned_process_count") != 0 or shutdown.get("ownership_observation_unavailable"):
            raise RuntimeError("installed_readiness_process_cleanup_unverified")
        return result


def _write_private(path: Path, value: dict[str, Any]) -> None:
    if path.exists() or path.is_symlink():
        raise ValueError("readiness output already exists")
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False, sort_keys=True, indent=2)
        stream.write("\n")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--arm", choices=("legacy", "candidate"), required=True)
    parser.add_argument("--installation-root", type=Path, required=True)
    parser.add_argument("--commands-json", required=True,
                        help="JSON array of absolute launch command arrays with installation placeholders")
    parser.add_argument("--manifest-sha256", required=True)
    parser.add_argument("--fixture-seed-root", type=Path, required=True)
    parser.add_argument("--fixture-seed-manifest-sha256", required=True)
    parser.add_argument("--campaign-model", required=True)
    parser.add_argument("--campaign-reasoning-effort", required=True)
    parser.add_argument("--loopback-model", required=True)
    parser.add_argument("--loopback-reasoning-effort", required=True)
    parser.add_argument("--timezone", required=True)
    parser.add_argument("--locale", required=True)
    parser.add_argument("--scratch-parent", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--failure-output", type=Path,
                        help="Optional private sanitized failure receipt, written only for a partial loopback read sequence")
    args = parser.parse_args()
    try:
        commands = json.loads(args.commands_json)
    except ValueError:
        raise SystemExit("commands JSON invalid") from None
    if not isinstance(commands, list) or not all(
        isinstance(command, list) and command and all(isinstance(arg, str) for arg in command)
        for command in commands
    ):
        raise SystemExit("commands JSON must be a non-empty array of string arrays")
    output_path = args.output.resolve(strict=False)
    failure_output_path = (args.failure_output.resolve(strict=False)
                           if args.failure_output is not None else None)
    protected_roots = [REPO.resolve(strict=False), PRODUCTION_DATA.resolve(strict=False),
                       (Path.home() / ".butler").resolve(strict=False)]
    if os.environ.get("BUTLER_DATA"):
        protected_roots.append(Path(os.environ["BUTLER_DATA"]).expanduser().resolve(strict=False))
    protected_roots.append(args.installation_root.resolve(strict=True))
    if any(output_path == root or output_path.is_relative_to(root) for root in protected_roots):
        raise SystemExit("readiness output must be outside source and production DATA")
    if failure_output_path is not None and (
        failure_output_path == output_path or any(
            failure_output_path == root or failure_output_path.is_relative_to(root)
            for root in protected_roots
        )
    ):
        raise SystemExit("readiness failure output must be distinct and outside source and production DATA")
    result = run_probe(
        arm=args.arm,
        installation_root=args.installation_root,
        command_templates=commands,
        expected_manifest_sha256=args.manifest_sha256,
        fixture_seed_root=args.fixture_seed_root,
        expected_fixture_seed_manifest_sha256=args.fixture_seed_manifest_sha256,
        campaign_model=args.campaign_model,
        campaign_reasoning_effort=args.campaign_reasoning_effort,
        loopback_model=args.loopback_model,
        loopback_reasoning_effort=args.loopback_reasoning_effort,
        timezone=args.timezone,
        locale=args.locale,
        scratch_parent=args.scratch_parent,
        failure_output=failure_output_path,
    )
    _write_private(args.output, result)
    print(json.dumps({"status": result["status"], "arm": result["arm"],
                      "installation_manifest_sha256": result["installation_manifest_sha256"],
                      "launch_spec_sha256": result["launch_spec_sha256"],
                      "canonical_read_evidence_sha256": result["canonical_read_evidence_sha256"],
                      "output": str(args.output)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
