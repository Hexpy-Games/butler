"""Focused checks for public timing and final artifact evidence wiring."""

from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

from distribution_evidence import bun_executable_evidence, inspect_distribution
from process_metrics import Identity, Process
from shutdown_evidence import inspect_listener_residue
from summary import local_residual_ns
from turn_observer import _PublicToolProgress


class EvidenceTests(unittest.TestCase):
    def test_public_tool_progress_pairs_current_turn_without_exposing_call_id(self):
        tracker = _PublicToolProgress("turn-current")
        call_id = "opaque-call-fixture"
        start_ns, finish_ns, request_ns = 200, 1_300_200, 100
        for state, observed_ns in (("running", start_ns), ("completed", finish_ns)):
            tracker.observe({
                "type": "agent.turn_event.progress",
                "payload": {"turn_id": "turn-current", "row": {
                    "tool_call_id": call_id, "safe_tool_name": "query_memory", "state": state}},
            }, observed_ns)
        tracker.observe({
            "type": "agent.turn_event.progress",
            "payload": {"turn_id": "another-turn", "row": {
                "tool_call_id": "unrelated", "safe_tool_name": "write_file", "state": "running"}},
        }, finish_ns + 1)
        evidence = tracker.summary(request_ns)
        self.assertEqual(evidence["status"], "observed")
        self.assertEqual(evidence["completed_interval_count"], 1)
        self.assertEqual(evidence["intervals"][0]["tool_name"], "query_memory")
        self.assertAlmostEqual(evidence["intervals"][0]["duration_ms"], 1.3)
        self.assertNotIn(call_id, repr(evidence))
        self.assertIsNone(local_residual_ns(4_000_000, None, [(100, 200)]))

    def test_canonical_bun_sha_hashes_symlink_target_without_running_it(self):
        with tempfile.TemporaryDirectory(prefix="rust-benchmark-bun-fixture-") as temporary:
            root = Path(temporary)
            target = root / "bun-fixture"
            target.write_bytes(b"synthetic executable fixture")
            target.chmod(0o700)
            link = root / "bun"
            link.symlink_to(target)
            with patch("distribution_evidence.BUN_PATH", link):
                evidence = bun_executable_evidence()
        self.assertEqual(evidence["status"], "observed")
        self.assertEqual(evidence["canonical_path"], str(target.resolve()))
        self.assertEqual(len(evidence["sha256"]), 64)

    def test_transitive_bundled_dylib_closure_is_hashed(self):
        with tempfile.TemporaryDirectory(prefix="rust-benchmark-dylib-fixture-") as temporary:
            root = Path(temporary)
            executable = root / "bin" / "native-agent"
            helper = root / "Frameworks" / "libfixture.dylib"
            executable.parent.mkdir()
            helper.parent.mkdir()
            executable.write_bytes(b"synthetic executable")
            helper.write_bytes(b"synthetic dylib")
            executable.chmod(0o700)
            helper.chmod(0o700)

            def image_types(path):
                return {"EXECUTE"} if path.name == executable.name else {"DYLIB"}

            def dependencies(path):
                return (["@rpath/libfixture.dylib"] if path.name == executable.name
                        else ["/usr/lib/libSystem.B.dylib"])

            def rpaths(path):
                return ["@loader_path/../Frameworks"] if path.name == executable.name else []

            with patch("distribution_evidence._is_macho", return_value=True):
                with patch("distribution_evidence._macho_filetypes", side_effect=image_types):
                    with patch("distribution_evidence._macho_dependencies", side_effect=dependencies):
                        with patch("distribution_evidence._macho_rpaths", side_effect=rpaths):
                            evidence = inspect_distribution(root, [[str(executable)]])
        self.assertEqual(evidence["status"], "observed")
        self.assertEqual(evidence["executable_count"], 1)
        self.assertEqual(evidence["dylib_count"], 1)
        self.assertEqual(evidence["dependency_closure"]["edge_count"], 2)
        self.assertEqual(evidence["first_party_backend_runtime_dependency"]["present"], False)
        bundled = [edge for edge in evidence["dependency_closure"]["edges"]
                   if edge["classification"] == "bundled"]
        self.assertEqual(len(bundled), 1)
        self.assertEqual(len(bundled[0]["bundled_sha256"]), 64)

    def test_shutdown_listener_check_distinguishes_empty_and_owned_residue(self):
        no_listener = SimpleNamespace(returncode=1, stdout="", stderr="")
        with patch("shutdown_evidence.subprocess.run", return_value=no_listener):
            empty = inspect_listener_residue(32100, set())
        self.assertEqual(empty["status"], "observed")
        self.assertEqual(empty["listener_count"], 0)

        listener = SimpleNamespace(returncode=0, stdout="p123\n", stderr="")
        identity = Identity(123, "Sat Sep 19 12:34:56 2026")
        process = Process(identity, 1, 0.1, 1024, "S")
        snapshot = SimpleNamespace(processes={123: process})
        with patch("shutdown_evidence.subprocess.run", return_value=listener):
            with patch("shutdown_evidence.collect_ps", return_value=snapshot):
                residue = inspect_listener_residue(32100, {identity})
        self.assertEqual(residue["status"], "observed")
        self.assertEqual(residue["owned_listener_count"], 1)
        self.assertTrue(residue["listener_residue"])
        self.assertNotIn("123", repr(residue))


if __name__ == "__main__":
    unittest.main()
