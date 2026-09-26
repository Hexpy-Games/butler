"""Strict validation for the root-reviewed, artifact-bound readiness receipt."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any


ACCEPTED_LEGACY_FAILURE_SHA256 = "ab980f28bd85322a0153e2b4b64a787c95be5f62c212e09d194275849aa5ed35"
ACCEPTED_LEGACY_PROVIDER_SHA256 = "d64b5668dc2b29731165e0fd5770d38c5a0bab8ea034c4491b423eb77a52aa68"


def _accepted_legacy_read(record: dict[str, Any], facts: dict[str, str],
                          expected_sources: list[dict[str, str]]) -> bool:
    """Accept the reviewed public journal while retaining its loopback failure."""
    if record.get("loopback_provider_clean") is not False:
        return False
    path_value = record.get("accepted_failure_receipt_file")
    if not isinstance(path_value, str):
        raise ValueError("accepted legacy failure receipt missing")
    raw = Path(path_value).read_bytes()
    if hashlib.sha256(raw).hexdigest() != ACCEPTED_LEGACY_FAILURE_SHA256:
        raise ValueError("accepted legacy failure receipt differs")
    failure = json.loads(raw)
    if failure.get("status") != "not_observed" or failure.get("arm") != "legacy" or \
       failure.get("installation_manifest_sha256") != facts["manifest_sha256"] or \
       failure.get("launch_spec_sha256") != facts["launch_spec_sha256"]:
        raise ValueError("accepted legacy failure is not bound to this installation")
    turn = failure.get("loopback_public_turn", {})
    journal = failure.get("tool_journal_readback", {})
    expected_names = [name for _ in expected_sources
                      for name in ("query_memory", "read_conversation_session")]
    calls = journal.get("calls", [])
    if turn.get("terminal_state") != "delivered" or \
       turn.get("fixture_pairs_completed") != len(expected_sources) or \
       turn.get("final_text_matched") is not True or \
       not turn.get("provider_error_codes") or \
       journal.get("status") != "observed" or \
       journal.get("canonical_sources_complete") is not True or \
       journal.get("canonical_sources_read") != [row["source_message_id"] for row in expected_sources] or \
       [row.get("tool_name") for row in calls] != expected_names or \
       any(row.get("status") != "completed" or row.get("error_code") is not None for row in calls):
        raise ValueError("accepted legacy canonical journal evidence incomplete")
    if record.get("canonical_read_evidence_sha256") != ACCEPTED_LEGACY_FAILURE_SHA256:
        raise ValueError("accepted legacy journal digest differs")
    provider_path = record.get("actual_provider_receipt_file")
    if not isinstance(provider_path, str):
        raise ValueError("accepted legacy provider receipt missing")
    provider_raw = Path(provider_path).read_bytes()
    if hashlib.sha256(provider_raw).hexdigest() != ACCEPTED_LEGACY_PROVIDER_SHA256:
        raise ValueError("accepted legacy provider receipt differs")
    provider = json.loads(provider_raw)
    if provider.get("arm") != "legacy" or provider.get("status") != "not_observed" or \
       provider.get("installation_manifest_sha256") != facts["manifest_sha256"] or \
       provider.get("launch_spec_sha256") != facts["launch_spec_sha256"] or \
       provider.get("settings_readback", {}).get("status") != "observed" or \
       provider.get("turn_control_readback", {}).get("status") != "observed" or \
       provider.get("guided_turn", {}).get("terminal_state") != "delivered" or \
       provider.get("installation_immutable", {}).get("status") != "observed" or \
       provider.get("owned_cleanup", {}).get("status") != "observed":
        raise ValueError("accepted legacy actual provider readiness incomplete")
    return True


def digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def expected_canonical_reads(workload: dict[str, Any]) -> list[dict[str, str]]:
    return [
        {
            "fixture_id": source["id"],
            "source_message_id": source["message_id"],
            "query_memory": "completed",
            "query_source": "conversation-store",
            "read_conversation_session": "completed",
            "read_message_id": source["message_id"],
            "read_text_sha256": hashlib.sha256(source["text"].encode("utf-8")).hexdigest(),
        }
        for source in workload["sources"]
    ]


def validate_readiness_receipt(
    receipt: dict[str, Any],
    *,
    model: str,
    reasoning_effort: str,
    workload: dict[str, Any],
    arm_facts: dict[str, dict[str, str]],
    fixture_procedure_sha256: str,
) -> None:
    if receipt.get("schema") != "butler.rust-benchmark.readiness.v3":
        raise ValueError("artifact-bound readiness receipt missing")
    if receipt.get("model") != model or receipt.get("reasoning_effort") != reasoning_effort:
        raise ValueError("readiness receipt model selection differs")
    if receipt.get("fallback_settings") != {"enabled": False, "models": []}:
        raise ValueError("readiness receipt fallback settings are not disabled")
    if receipt.get("fixture_procedure_sha256") != fixture_procedure_sha256:
        raise ValueError("readiness receipt fixture procedure differs")
    arms = receipt.get("arms")
    if not isinstance(arms, dict) or set(arms) != {"legacy", "candidate"}:
        raise ValueError("readiness receipt arm set invalid")

    expected_sources = expected_canonical_reads(workload)
    for arm, facts in arm_facts.items():
        record = arms.get(arm)
        if not isinstance(record, dict):
            raise ValueError(f"{arm} readiness receipt missing")
        if record.get("installation_manifest_sha256") != facts["manifest_sha256"]:
            raise ValueError("readiness receipt is for another installation")
        if record.get("launch_spec_sha256") != facts["launch_spec_sha256"]:
            raise ValueError("readiness receipt launch command differs")
        if record.get("model") != model or record.get("reasoning_effort") != reasoning_effort:
            raise ValueError("arm readiness receipt model selection differs")
        if record.get("fallback_settings") != {"enabled": False, "models": []}:
            raise ValueError("arm fallback settings are not disabled")

        if arm == "legacy" and _accepted_legacy_read(record, facts, expected_sources):
            continue

        canonical = record.get("canonical_read_evidence")
        if not isinstance(canonical, dict) or canonical.get("status") != "observed":
            raise ValueError("installed public canonical read evidence missing")
        if canonical.get("schema") != "butler.rust-benchmark.canonical-read.v2" or \
           canonical.get("verification_route") != "installed-public-guided-turn-journal" or \
           canonical.get("api_surface") != "installed-public-guided-turn" or \
           canonical.get("lookup_tool") != "query_memory" or \
           canonical.get("source_read_tool") != "read_conversation_session":
            raise ValueError("installed canonical read proof route differs")
        if canonical.get("installation_manifest_sha256") != facts["manifest_sha256"] or \
           canonical.get("launch_spec_sha256") != facts["launch_spec_sha256"]:
            raise ValueError("installed canonical read proof is not bound to this arm")
        effective = canonical.get("effective_campaign_model_configuration")
        if not isinstance(effective, dict) or {
            key: value for key, value in effective.items() if key != "source"
        } != {
            "model": model,
            "reasoning_effort": reasoning_effort,
            "fallback_settings": {"enabled": False, "models": []},
        } or effective.get("source") not in {
            "authenticated_public_settings_read",
            "authenticated_public_settings_patch_then_read",
        }:
            raise ValueError("installed campaign settings were not observed on the public route")
        loopback = canonical.get("loopback_public_turn")
        if not isinstance(loopback, dict) or loopback.get("status") != "observed" or \
           loopback.get("transport") != "isolated_loopback_openai_responses" or \
           loopback.get("endpoint_host") != "127.0.0.1" or \
           loopback.get("model") != "openai/gpt-5.5" or \
           loopback.get("reasoning_effort") != "medium" or \
           not isinstance(loopback.get("provider_requests"), int) or \
           loopback.get("provider_requests", 0) < 15 or \
           loopback.get("terminal_state") != "delivered" or \
           loopback.get("guided_tool_invocations") != 14:
            raise ValueError("installed loopback Guided Turn proof is incomplete")
        journal = canonical.get("journal_readback")
        expected_names = [name for _source in expected_sources
                          for name in ("query_memory", "read_conversation_session")]
        if not isinstance(journal, dict) or journal.get("status") != "observed" or \
           journal.get("basis") != "installed_public_guided_turn_tool_journal" or \
           journal.get("tool_invocation_count") != 14 or \
           journal.get("tool_names_in_order") != expected_names or \
           journal.get("canonical_reads_complete") is not True or \
           not isinstance(journal.get("sources"), list) or len(journal["sources"]) != 7:
            raise ValueError("installed Guided Turn journal readback is incomplete")
        for actual, expected in zip(journal["sources"], expected_sources, strict=True):
            if not isinstance(actual, dict) or any(actual.get(key) != value
                                                   for key, value in expected.items()) or \
               not isinstance(actual.get("read_args_sha256"), str) or \
               len(actual["read_args_sha256"]) != 64 or \
               any(char not in "0123456789abcdef" for char in actual["read_args_sha256"]):
                raise ValueError("installed Guided Turn journal source evidence differs")
        if canonical.get("sources") != expected_sources:
            raise ValueError("F1-F7 installed canonical lookup/read evidence incomplete")
        if canonical.get("active_generation_before") != "absent" or \
           canonical.get("active_generation_after") != "absent" or \
           canonical.get("embedding_asset_cache_before") != "absent" or \
           canonical.get("embedding_asset_cache_after") != "absent" or \
           canonical.get("daily_session_sync") != "suppressed_for_local_day" or \
           canonical.get("daily_consolidation_cycle") != "suppressed_for_local_day" or \
           canonical.get("local_day_window_held") is not True:
            raise ValueError("no-generation canonical read conditions not verified")
        if record.get("canonical_read_evidence_sha256") != digest(canonical):
            raise ValueError("canonical read evidence digest differs")

        owner = record.get("embedding_owner_conditions")
        expected_owner = {
            "active_generation": "absent",
            "exact_lookup_and_read_only": True,
            "recall_resolves_generation_before_embedding": True,
            "daily_session_sync": "suppressed_for_local_day",
            "daily_consolidation_cycle": "suppressed_for_local_day",
            "asset_downloads_observed": 0,
            "embedding_owner_invocations": "unavailable_no_public_owner_registry",
        }
        if owner != expected_owner:
            raise ValueError("embedding owner conditions are not bound to the receipt")
