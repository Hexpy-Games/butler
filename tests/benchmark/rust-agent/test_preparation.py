import io
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

from app_protocol import AppClient, AppProtocolError
from correctness import _meeting_roles_are_correct, _plain_answer, assess_case, workspace_hashes
from launch import OwnedLaunch, artifact_manifest, verify_artifact_unchanged
from process_metrics import SampleUnavailable
from run_campaign import (
    _active_generation_present,
    _embedding_asset_snapshot,
    _load_provider_input,
    _prepare_arm,
    _stored_model_registration,
    _write_provider_credential,
)
from readiness import digest, expected_canonical_reads, validate_readiness_receipt
from summary import ARM_ORDER, interval_union_ns, paired_report
from tool_evidence import inspect_tool_journal
from turn_observer import observe_delegated_result
from workload import load_workload


class PreparationTests(unittest.TestCase):
    def test_transport_timeout_evidence_omits_endpoint_and_token(self):
        class TimeoutOpener:
            def open(self, *_args, **_kwargs):
                raise TimeoutError("private endpoint detail")

        client = AppClient("http://127.0.0.1:12345", "private-token")
        client._opener = TimeoutOpener()
        with self.assertRaises(AppProtocolError) as caught:
            client.session_view("private-session")
        error = caught.exception
        self.assertEqual((error.code, error.request_kind, error.cause_code),
                         ("app_transport_unavailable", "GET /session-view", "timeout"))
        self.assertIsNotNone(error.elapsed_ms)
        self.assertNotIn("private", str(error))

    def test_delegated_observation_uses_exact_parent_turn(self):
        class Client:
            def session_view(self, _session_id):
                return type("Response", (), {
                    "response_ns": 4_000_000,
                    "data": {"steward_children": [
                        {"relation": {"relation_id": "other", "parent_turn_id": "other-turn"},
                         "terminal": True, "result": {"child_turn_id": "wrong", "status": "success"}},
                        {"relation": {"relation_id": "wanted", "parent_turn_id": "parent-turn"},
                         "session_id": "child-session", "terminal": True,
                         "result": {"child_turn_id": "child-turn", "status": "success",
                                    "summary": "completed"}},
                    ]},
                })()

        observed = observe_delegated_result(Client(), parent_session_id="parent-session",
                                            parent_turn_id="parent-turn")
        self.assertEqual((observed.relation_id, observed.child_turn_id, observed.status),
                         ("wanted", "child-turn", "success"))

    def test_isolated_fixture_seeding_does_not_claim_installed_public_readiness(self):
        with tempfile.TemporaryDirectory(prefix="butler-rust-canonical-read-") as temporary:
            pair = Path(temporary) / "pair"
            pair.mkdir(mode=0o700)
            prepared = _prepare_arm(pair, "legacy", "UTC")
            self.assertIsNone(prepared["canonical_read_evidence"])
            self.assertIsNone(prepared["canonical_read_evidence_sha256"])
            self.assertFalse((prepared["evidence"] / "canonical-read-readiness.json").exists())
            self.assertFalse(_active_generation_present(prepared["data"]))
            self.assertFalse(_embedding_asset_snapshot(prepared["data"])["root_present"])
            self.assertEqual(prepared["config"]["user"]["modelFallback"],
                             {"enabled": False, "models": []})
            self.assertNotIn("memory", prepared["config"])
            for job in ("session-sync", "consolidation-cycle"):
                marker = prepared["data"] / "state" / "scheduler" / f"{job}.json"
                self.assertEqual(json.loads(marker.read_text(encoding="utf-8"))["lastRunDate"],
                                 prepared["local_day"])

    def test_readiness_receipt_binds_every_canonical_source_and_both_artifact_launches(self):
        workload = load_workload()
        arm_facts = {
            arm: {"manifest_sha256": ("a" if arm == "legacy" else "b") * 64,
                  "launch_spec_sha256": ("c" if arm == "legacy" else "d") * 64}
            for arm in ("legacy", "candidate")
        }
        expected = expected_canonical_reads(workload)
        owner = {
            "active_generation": "absent",
            "exact_lookup_and_read_only": True,
            "recall_resolves_generation_before_embedding": True,
            "daily_session_sync": "suppressed_for_local_day",
            "daily_consolidation_cycle": "suppressed_for_local_day",
            "asset_downloads_observed": 0,
            "embedding_owner_invocations": "unavailable_no_public_owner_registry",
        }
        receipt = {
            "schema": "butler.rust-benchmark.readiness.v3",
            "fixture_procedure_sha256": "e" * 64,
            "model": "zai/fixture-model",
            "reasoning_effort": "high",
            "fallback_settings": {"enabled": False, "models": []},
            "arms": {},
        }
        for arm, facts in arm_facts.items():
            journal_sources = [{**row, "read_args_sha256": "f" * 64} for row in expected]
            canonical = {
                "schema": "butler.rust-benchmark.canonical-read.v2",
                "status": "observed",
                "verification_route": "installed-public-guided-turn-journal",
                "installation_manifest_sha256": facts["manifest_sha256"],
                "launch_spec_sha256": facts["launch_spec_sha256"],
                "lookup_tool": "query_memory",
                "source_read_tool": "read_conversation_session",
                "api_surface": "installed-public-guided-turn",
                "effective_campaign_model_configuration": {
                    "model": "zai/fixture-model", "reasoning_effort": "high",
                    "fallback_settings": {"enabled": False, "models": []},
                    "source": "authenticated_public_settings_read",
                },
                "loopback_public_turn": {
                    "status": "observed", "model": "openai/gpt-5.5",
                    "reasoning_effort": "medium",
                    "transport": "isolated_loopback_openai_responses",
                    "endpoint_host": "127.0.0.1", "provider_requests": 15,
                    "guided_tool_invocations": 14, "terminal_state": "delivered",
                },
                "journal_readback": {
                    "status": "observed", "basis": "installed_public_guided_turn_tool_journal",
                    "tool_invocation_count": 14,
                    "tool_names_in_order": [name for _row in expected
                                             for name in ("query_memory", "read_conversation_session")],
                    "canonical_reads_complete": True, "sources": journal_sources,
                },
                "active_generation_before": "absent",
                "active_generation_after": "absent",
                "embedding_asset_cache_before": "absent",
                "embedding_asset_cache_after": "absent",
                "daily_session_sync": "suppressed_for_local_day",
                "daily_consolidation_cycle": "suppressed_for_local_day",
                "local_day_window_held": True,
                "sources": expected,
            }
            receipt["arms"][arm] = {
                "installation_manifest_sha256": facts["manifest_sha256"],
                "launch_spec_sha256": facts["launch_spec_sha256"],
                "model": "zai/fixture-model",
                "reasoning_effort": "high",
                "fallback_settings": {"enabled": False, "models": []},
                "canonical_read_evidence": canonical,
                "canonical_read_evidence_sha256": digest(canonical),
                "embedding_owner_conditions": owner,
            }
        validate_readiness_receipt(receipt, model="zai/fixture-model",
                                   reasoning_effort="high", workload=workload,
                                   arm_facts=arm_facts,
                                   fixture_procedure_sha256="e" * 64)
        candidate_evidence = receipt["arms"]["candidate"]["canonical_read_evidence"]
        candidate_evidence["schema"] = "butler.rust-benchmark.canonical-read.v1"
        receipt["arms"]["candidate"]["canonical_read_evidence_sha256"] = digest(candidate_evidence)
        with self.assertRaisesRegex(ValueError, "proof route differs"):
            validate_readiness_receipt(receipt, model="zai/fixture-model",
                                       reasoning_effort="high", workload=workload,
                                       arm_facts=arm_facts,
                                       fixture_procedure_sha256="e" * 64)
        candidate_evidence["schema"] = "butler.rust-benchmark.canonical-read.v2"
        receipt["arms"]["candidate"]["canonical_read_evidence_sha256"] = digest(candidate_evidence)
        receipt["arms"]["candidate"]["canonical_read_evidence"]["sources"].pop()
        receipt["arms"]["candidate"]["canonical_read_evidence_sha256"] = digest(
            receipt["arms"]["candidate"]["canonical_read_evidence"])
        with self.assertRaisesRegex(ValueError, "F1-F7"):
            validate_readiness_receipt(receipt, model="zai/fixture-model",
                                       reasoning_effort="high", workload=workload,
                                       arm_facts=arm_facts,
                                       fixture_procedure_sha256="e" * 64)

    def test_checkout_typescript_executor_claim_cannot_satisfy_installed_receipt(self):
        workload = load_workload()
        arm_facts = {
            arm: {"manifest_sha256": ("a" if arm == "legacy" else "b") * 64,
                  "launch_spec_sha256": ("c" if arm == "legacy" else "d") * 64}
            for arm in ("legacy", "candidate")
        }
        with self.assertRaisesRegex(ValueError, "readiness receipt missing"):
            validate_readiness_receipt(
                {"schema": "butler.rust-benchmark.readiness.v2"},
                model="zai/fixture-model", reasoning_effort="high", workload=workload,
                arm_facts=arm_facts, fixture_procedure_sha256="e" * 64)

    def test_selected_zai_credential_is_identical_in_isolated_data_without_output(self):
        secret = "synthetic-zai-secret-must-not-print"
        with tempfile.TemporaryDirectory(prefix="butler-rust-credential-test-") as temporary:
            root = Path(temporary)
            source = root / "selected-credentials.json"
            source.write_text(json.dumps({"credentials": [
                {"id": "openai-fixture", "provider_id": "openai", "auth_type": "api_key",
                 "secret": "synthetic-openai-secret"},
                {"id": "zai-other", "provider_id": "zai", "auth_type": "api_key",
                 "secret": "synthetic-other-zai-secret"},
                {"id": "zai-selected", "provider_id": "zai", "auth_type": "api_key",
                 "secret": secret, "label": "fixture label", "unexpected": "discarded"},
            ]}), encoding="utf-8")
            source.chmod(0o600)
            contract = {"model": "zai/glm-5.3",
                        "provider_credential_file": str(source),
                        "provider_credential_id": "zai-selected"}
            output = io.StringIO()
            with redirect_stdout(output):
                provider_input = _load_provider_input(contract)
                legacy_path = _write_provider_credential(
                    root / "legacy" / "data", provider_input["credential"])
                native_path = _write_provider_credential(
                    root / "native" / "data", provider_input["credential"])

            self.assertEqual(output.getvalue(), "")
            self.assertNotIn(secret, output.getvalue())
            self.assertEqual(legacy_path.read_bytes(), native_path.read_bytes())
            self.assertEqual(legacy_path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(legacy_path.parent.stat().st_mode & 0o777, 0o700)
            stored = json.loads(legacy_path.read_text(encoding="utf-8"))
            self.assertEqual(stored, {"credentials": [{
                "id": "zai-selected", "provider_id": "zai", "auth_type": "api_key",
                "secret": secret,
            }]})
            self.assertEqual(_stored_model_registration("zai/glm-5.3",
                                                         provider_input["credential"]), {
                "provider_id": "zai", "model_id": "glm-5.3", "auth_type": "api_key",
                "credential_id": "zai-selected",
            })

    def test_stored_credential_selection_requires_id_when_multiple_zai_records_exist(self):
        with tempfile.TemporaryDirectory(prefix="butler-rust-credential-select-") as temporary:
            root = Path(temporary)
            source = root / "credentials.json"
            source.write_text(json.dumps({"credentials": [
                {"id": "zai-one", "provider_id": "zai", "auth_type": "api_key", "secret": "one"},
                {"id": "zai-two", "provider_id": "zai", "auth_type": "api_key", "secret": "two"},
            ]}), encoding="utf-8")
            source.chmod(0o600)
            with self.assertRaisesRegex(ValueError, "explicit provider credential id"):
                _load_provider_input({"model": "zai/glm-5.3",
                                      "provider_credential_file": str(source)})

    def test_existing_provider_environment_input_remains_available(self):
        with tempfile.TemporaryDirectory(prefix="butler-rust-provider-env-test-") as temporary:
            source = Path(temporary) / "provider-env.json"
            source.write_text(json.dumps({"OPENAI_API_KEY": "synthetic-provider-env-secret"}),
                              encoding="utf-8")
            source.chmod(0o600)
            contract = {"legacy": {"provider_env_file": str(source)},
                        "candidate": {"provider_env_file": str(source)}}
            self.assertEqual(_load_provider_input(contract), {
                "mode": "environment",
                "environment": {"OPENAI_API_KEY": "synthetic-provider-env-secret"},
            })
            source.write_text(json.dumps({"BUTLER_COGNITION_MEMORY_HOME": str(Path(temporary) / "outside")}),
                              encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "isolated runtime boundaries"):
                _load_provider_input(contract)

    def test_stored_credential_input_rejects_environment_fallback_and_production_path_before_read(self):
        with tempfile.TemporaryDirectory(prefix="butler-rust-credential-boundary-") as temporary:
            root = Path(temporary)
            source = root / "credentials.json"
            source.write_text(json.dumps({"credentials": []}), encoding="utf-8")
            source.chmod(0o600)
            both_modes = {"model": "zai/glm-5.3",
                          "provider_credential_file": str(source),
                          "legacy": {"provider_env_file": str(source)},
                          "candidate": {"provider_env_file": str(source)}}
            with patch("run_campaign._private_file") as private_read:
                with self.assertRaisesRegex(ValueError, "mutually exclusive"):
                    _load_provider_input(both_modes)
                private_read.assert_not_called()

            production = root / ".butler"
            production.mkdir()
            production_source = production / "auth.json"
            production_source.write_text("{}", encoding="utf-8")
            production_source.chmod(0o600)
            with patch("run_campaign.PRODUCTION_DATA", production):
                with patch("run_campaign._private_file") as private_read:
                    with self.assertRaisesRegex(ValueError, "separate from source and production"):
                        _load_provider_input({"model": "zai/glm-5.3",
                                              "provider_credential_file": str(production_source)})
                    private_read.assert_not_called()

            configured_data = root / "configured-production"
            configured_data.mkdir()
            configured_source = configured_data / "credentials.json"
            configured_source.write_text("{}", encoding="utf-8")
            configured_source.chmod(0o600)
            with patch.dict("os.environ", {"BUTLER_DATA": str(configured_data)}):
                with patch("run_campaign._private_file") as private_read:
                    with self.assertRaisesRegex(ValueError, "separate from source and production"):
                        _load_provider_input({"model": "zai/glm-5.3",
                                              "provider_credential_file": str(configured_source)})
                    private_read.assert_not_called()

    def test_answer_framing_and_meeting_roles(self):
        for value in ("**CEDAR-4821**", "`CEDAR-4821`", "```text\nCEDAR-4821\n```"):
            self.assertEqual(_plain_answer(value), "CEDAR-4821")
        self.assertTrue(_meeting_roles_are_correct("현재 번호는 417이고 이전 301은 폐기되었습니다."))
        self.assertTrue(_meeting_roles_are_correct("301에서 417로 변경했고 301은 폐기됐습니다."))
        self.assertFalse(_meeting_roles_are_correct("현재 번호는 301이고 이전 417은 폐기되었습니다."))

    def test_frozen_outputs_and_failed_pair_are_preserved(self):
        workload = load_workload()
        self.assertEqual(len(workload["sources"]), 7)
        self.assertEqual(len(workload["cases"]), 10)
        self.assertEqual(interval_union_ns([(1, 5), (3, 7), (8, 9)]), 7)
        pairs = [{"order": list(order),
                  "legacy": {"accuracy_passed": True, "boot_full_ms": 10},
                  "candidate": {"accuracy_passed": index != 1, "boot_full_ms": 8,
                                "failure_codes": ["answer_incorrect"] if index == 1 else []}}
                 for index, order in enumerate(ARM_ORDER)]
        report = paired_report(pairs, "boot_full_ms")
        self.assertEqual(len(report["pairs"]), 3)
        self.assertEqual(report["valid_pair_count"], 2)
        self.assertIsNone(report["pairs"][1]["percent_difference"])

    def test_tool_evidence_and_workspace_effects(self):
        with tempfile.TemporaryDirectory(prefix="butler-rust-prep-test-") as temporary:
            root = Path(temporary)
            data = root / "data"
            db = data / "agent-runtime" / "btcc.sqlite"
            db.parent.mkdir(parents=True)
            connection = sqlite3.connect(db)
            connection.execute("CREATE TABLE btcc_guided_tool_calls (turn_id TEXT, tool_name TEXT, "
                               "status TEXT, result_json TEXT, started_at TEXT, finished_at TEXT, "
                               "error_code TEXT)")
            for tool, result in (("query_memory", "{}"),
                                 ("read_conversation_session", json.dumps({"id": "cm_rust_benchmark_f1"})),
                                 ("write_file", "{}")):
                connection.execute("INSERT INTO btcc_guided_tool_calls VALUES (?,?,?,?,?,?,?)",
                                   ("turn-1", tool, "completed", result,
                                    "2026-01-01T00:00:00Z", "2026-01-01T00:00:01Z", None))
            connection.commit()
            connection.close()
            workspace = root / "workspace"
            workspace.mkdir()
            before = workspace_hashes(workspace)
            output = load_workload()["cases"][6]["output"]
            target = workspace / output["path"]
            target.parent.mkdir()
            target.write_text(output["text"])
            evidence = inspect_tool_journal(data, "turn-1", {"cm_rust_benchmark_f1"},
                                            {"query_memory", "read_conversation_session", "write_file"})
            self.assertTrue(evidence["canonical_sources_complete"])
            self.assertEqual(assess_case({"id": 7, "output": output}, "완료", "delivered",
                                         evidence, before, workspace_hashes(workspace)), [])

    def test_installation_change_is_detected(self):
        with tempfile.TemporaryDirectory(prefix="butler-rust-manifest-test-") as temporary:
            root = Path(temporary)
            file = root / "native"
            file.write_bytes(b"one")
            manifest = artifact_manifest(root)
            verify_artifact_unchanged(root, manifest)
            file.write_bytes(b"two")
            with self.assertRaises(RuntimeError):
                verify_artifact_unchanged(root, manifest)

    def test_unidentified_owned_child_is_reaped_on_ps_failure(self):
        with tempfile.TemporaryDirectory(prefix="butler-rust-owned-child-") as temporary:
            root = Path(temporary)
            launch = OwnedLaunch([["/bin/sleep", "10"]], root, {}, root / "logs")
            with patch("launch.collect_ps", side_effect=SampleUnavailable("synthetic")):
                with self.assertRaises(SampleUnavailable):
                    launch.start()
            self.assertEqual(len(launch.processes), 1)
            self.assertIsNotNone(launch.processes[0].poll())


if __name__ == "__main__":
    unittest.main()
