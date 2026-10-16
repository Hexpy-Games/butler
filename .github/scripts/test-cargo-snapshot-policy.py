#!/usr/bin/env python3
"""Freshness, retirement and publication evidence through the snapshot entrypoints."""
import contextlib
from datetime import datetime, timedelta, timezone
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('snapshots', Path(__file__).with_name('cargo-target-release.py'))
snapshots = importlib.util.module_from_spec(spec)
spec.loader.exec_module(snapshots)


class SnapshotPolicy(unittest.TestCase):
    # test-category: pure-logic
    def test_publish_only_stale_exact_green_snapshots_and_always_release(self):
        expected = dict(platform='windows-x64', kind='native', profile='ci-fast')
        metadata = dict(run_id=42, sha='a' * 40)
        generation = dict(metadata=metadata)
        published = dict(assets=[dict(name='42-1.json')])
        with tempfile.TemporaryDirectory() as temporary, \
                patch.dict(os.environ, RUNNER_TEMP=temporary, GITHUB_REPOSITORY='owner/repo', GITHUB_SHA='b' * 40), \
                patch.object(snapshots, 'release', return_value=published), \
                patch.object(snapshots, 'checked_generation', return_value=(generation, False)):
            for hours, commits, want in [(1, 19, False), (1, 20, True), (13, 0, True)]:
                created = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()
                with patch.object(snapshots, 'api', side_effect=[dict(created_at=created),
                                  dict(status='ahead', ahead_by=commits)]) as api:
                    self.assertEqual(snapshots.should_publish(expected), want)
                    self.assertIn('/actions/runs/42', api.call_args_list[0].args[0])
                    if hours < 12:
                        self.assertIn('/compare/', api.call_args.args[0])
            with patch.object(snapshots, 'api', side_effect=AssertionError('release must always publish')):
                self.assertTrue(snapshots.should_publish(dict(expected, profile='release')))
            with patch.object(snapshots, 'checked_generation', side_effect=snapshots.UnsuccessfulProducer('pending')), \
                    patch.object(snapshots, 'walk_back', return_value=None):
                self.assertTrue(snapshots.should_publish(expected))
            with patch.object(snapshots, 'release', return_value=None):
                self.assertTrue(snapshots.should_publish(expected))

    # test-category: pure-logic
    def test_publish_failure_is_nonfatal_with_class_and_full_summary(self):
        expected = dict(platform='windows-x64', mode='static-ort', kind='native', profile='ci-fast')
        with tempfile.TemporaryDirectory() as temporary, \
                patch.dict(os.environ, RUNNER_TEMP=temporary, GITHUB_RUN_ID='42', GITHUB_RUN_ATTEMPT='2',
                           GITHUB_STEP_SUMMARY=str(Path(temporary) / 'summary'), BUTLER_PERSISTENT_TARGET=''), \
                patch.object(snapshots.cache, 'identity', return_value=expected), \
                patch.object(snapshots, 'should_publish', side_effect=OSError('private diagnostic')), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            snapshots.publish_lane('windows-x64', 'static-ort', 'native')
            summary = (Path(temporary) / 'summary').read_text()
            self.assertIn('::warning::Cargo snapshot publish failed (OSError)', output.getvalue())
            self.assertNotIn('private diagnostic', output.getvalue())
            for field in ['lane=windows-x64/static-ort/native/ci-fast', 'key=compatible-',
                          'generation=42-2', 'exact', 'compressed bytes=0', 'minutes=', 'failed: OSError']:
                self.assertIn(field, summary)

    # test-category: pure-logic
    def test_free_floor_skips_restore_and_publish_without_remote_calls(self):
        expected = dict(platform='windows-x64', kind='native', profile='ci-fast')
        with tempfile.TemporaryDirectory() as temporary, \
                patch.dict(os.environ, RUNNER_TEMP=temporary, BUTLER_PERSISTENT_TARGET=temporary, GITHUB_RUN_ID='42'), \
                patch.object(snapshots.runner_cache, 'has_space', return_value=False), \
                patch.object(snapshots, 'persistent_target', return_value=Path(temporary)), \
                patch.object(snapshots, 'restore_local', return_value=False), \
                patch.object(snapshots, 'release') as remote, \
                patch.object(snapshots.cache, 'identity', return_value=expected), \
                patch.object(snapshots.cache, 'record') as record:
            self.assertFalse(snapshots.restore(expected))
            snapshots.publish_lane('windows-x64', 'static-ort', 'native')
            remote.assert_not_called()
            record.assert_not_called()


if __name__ == '__main__':
    unittest.main()
