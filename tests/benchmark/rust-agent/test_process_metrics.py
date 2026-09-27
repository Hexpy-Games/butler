"""Synthetic accounting checks; this never starts or benchmarks Butler."""

import os
import subprocess
import sys
import unittest

from process_metrics import Identity, Process, Snapshot, TreeAccounting, collect_ps, cpu_seconds, parse_ps


def process(pid, ppid, cpu=0, rss=1024, started="start-one"):
    return Process(Identity(pid, started), ppid, cpu, rss, "S")


def snapshot(second, *processes):
    return Snapshot(second - 0.01, second, {p.identity.pid: p for p in processes})


class ProcessAccountingTests(unittest.TestCase):
    def test_ps_units_and_large_cumulative_cpu(self):
        value = parse_ps("123 1 Sat Sep 19 12:34:56 2026 2-03:04:05.67 4096 S+\n")[123]
        self.assertEqual(value.rss_bytes, 4 * 1024 * 1024)
        self.assertEqual(value.cpu_seconds, 183845.67)
        self.assertEqual(cpu_seconds("1:02.50"), 62.5)
        with self.assertRaises(ValueError):
            parse_ps("123 missing columns")

    def test_descendants_reparent_exit_and_reused_pid(self):
        root = process(100, 1, 0.1)
        tracker = TreeAccounting([root.identity])
        first = tracker.sample(snapshot(1, process(102, 101, 0.3), process(999, 1, 10), process(101, 100, 0.2), root))
        self.assertEqual(first["process_count"], 3)
        self.assertAlmostEqual(first["observed_cpu_seconds"], 0.6)
        # An observed grandchild survives parent exit/reparenting; its new child belongs.
        second = tracker.sample(snapshot(2, root, process(102, 1, 0.8), process(103, 102, 0.2), process(101, 1, 50, started="reused")))
        self.assertEqual([p["pid"] for p in second["processes"]], [100, 102, 103])
        self.assertAlmostEqual(second["observed_cpu_seconds"], 1.3)
        self.assertAlmostEqual(second["cpu_percent_one_core_sampled"], 70)
        # Reused root/descendant PIDs and their children must not inherit ownership.
        third = tracker.sample(snapshot(3, process(100, 1, 100, started="reused"), process(104, 100, 100)))
        self.assertEqual(third["process_count"], 0)
        self.assertEqual(third["rss_sum_proxy_bytes"], 0)
        self.assertAlmostEqual(third["observed_cpu_seconds"], 1.3)
        self.assertEqual(third["coverage"]["departed_cpu_final_value_unavailable"], 4)

    def test_cpu_regression_is_visible_not_negative_utilization(self):
        root = process(100, 1, 1)
        tracker = TreeAccounting([root.identity])
        tracker.sample(snapshot(1, root))
        row = tracker.sample(snapshot(2, process(100, 1, 0.9)))
        self.assertEqual(row["cpu_counter_regressions"], [root.identity.wire()])
        self.assertEqual(row["cpu_percent_one_core_sampled"], 0)
        with self.assertRaises(ValueError):
            tracker.sample(snapshot(2, root))

    def test_failed_collection_preserves_counters_and_marks_gap_average(self):
        root = process(100, 1, 1)
        tracker = TreeAccounting([root.identity])
        tracker.sample(snapshot(1, root))
        tracker.record_unavailable()
        row = tracker.sample(snapshot(3, process(100, 1, 2)))
        self.assertEqual(row["interval_seconds"], 2)
        self.assertEqual(row["cpu_percent_one_core_sampled"], 50)
        self.assertTrue(row["cpu_interval_includes_collection_failure"])
        self.assertEqual(row["failed_collections_since_prior_sample"], 1)
        self.assertFalse(tracker.sample(snapshot(4, process(100, 1, 2)))["cpu_interval_includes_collection_failure"])

    def test_actual_owned_synthetic_child_can_be_observed_without_arguments(self):
        child = subprocess.Popen([sys.executable, "-c", "import sys; sys.stdin.read()"], stdin=subprocess.PIPE)
        try:
            current = collect_ps()
            root = current.processes[child.pid]
            self.assertEqual(root.ppid, os.getpid())
            row = TreeAccounting([root.identity]).sample(current)
            self.assertEqual(row["process_count"], 1)
            self.assertNotIn("command", row["processes"][0])
            self.assertNotIn("args", row["processes"][0])
        finally:
            child.communicate(timeout=5)
            if child.stdin:
                child.stdin.close()


if __name__ == "__main__":
    unittest.main()
