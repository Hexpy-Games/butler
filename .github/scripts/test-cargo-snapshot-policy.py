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
    def test_free_floor_skips_all_restores_and_nonrelease_publish_without_remote_calls(self):
        with tempfile.TemporaryDirectory() as temporary, \
                patch.dict(os.environ, RUNNER_TEMP=temporary, BUTLER_PERSISTENT_TARGET=temporary, GITHUB_RUN_ID='42'), \
                patch.object(snapshots.runner_cache, 'has_space', return_value=False), \
                patch.object(snapshots, 'persistent_target', return_value=Path(temporary)), \
                patch.object(snapshots, 'restore_local', return_value=False), \
                patch.object(snapshots, 'release') as remote, \
                patch.object(snapshots.cache, 'record') as record:
            for profile in ('ci-fast', 'debug', 'release'):
                with self.subTest(profile=profile):
                    expected = dict(platform='windows-x64', kind='native', profile=profile)
                    self.assertFalse(snapshots.restore(expected))
                    if profile != 'release':
                        with patch.object(snapshots.cache, 'identity', return_value=expected):
                            snapshots.publish_lane('windows-x64', 'static-ort', 'native')
            remote.assert_not_called()
            record.assert_not_called()

    # test-category: pure-logic
    def test_release_publishes_below_free_floor_even_with_a_fresh_snapshot(self):
        expected = dict(platform='windows-x64', mode='static-ort', kind='native', profile='release')
        with tempfile.TemporaryDirectory() as temporary, \
                patch.dict(os.environ, RUNNER_TEMP=temporary, BUTLER_PERSISTENT_TARGET=temporary, GITHUB_RUN_ID='42'), \
                patch.object(snapshots.runner_cache, 'has_space', return_value=False), \
                patch.object(snapshots.cache, 'identity', return_value=expected), \
                patch.object(snapshots, 'release') as remote, \
                patch.object(snapshots.policy, 'stale', return_value=False), \
                patch.object(snapshots.cache, 'record') as record, \
                patch.object(snapshots, 'publish') as publish, \
                patch.object(snapshots.policy, 'report') as report:
            snapshots.publish_lane('windows-x64', 'static-ort', 'native')
            remote.assert_not_called()
            record.assert_called_once()
            self.assertEqual(record.call_args.args[1], expected)
            publish.assert_called_once_with(record.call_args.args[0], '42')
            self.assertEqual(report.call_args.args[-1], 'published')

    # test-category: pure-logic
    def test_prune_retires_keys_after_fourteen_days_without_a_new_generation(self):
        def version(number, key, days, aliases=()):
            return dict(id=number, created_at=(datetime.now(timezone.utc) - timedelta(days=days)).isoformat(),
                        metadata={'container': {'tags': [key + f'--{number}-1', *aliases]}})
        active, old, warm = 'compatible-active', 'compatible-old', 'compatible-warm'
        versions = [version(1, old, 16, ('exact-old', old)), version(2, old, 15),
                    version(3, warm, 20), version(4, warm, 1), version(5, active, 30)]
        # A version carrying a live key cannot be removed with an old key.
        shared = version(6, old, 16, (warm + '--6-1',))
        versions.append(shared)
        with patch.dict(os.environ, GITHUB_REPOSITORY='owner/repo'), \
                patch.object(snapshots, 'api', side_effect=[versions, None, None]) as api, \
                contextlib.redirect_stdout(io.StringIO()) as output:
            snapshots.prune(active, '5-1', 12345)
        deleted = [call.args[0].rsplit('/', 1)[-1] for call in api.call_args_list if call.kwargs.get('method') == 'DELETE']
        self.assertEqual(deleted, ['1', '2'])
        self.assertIn('compressed bytes=12345', output.getvalue())
        # One new generation protects every generation of that key from retirement.
        versions.append(version(7, old, 1))
        self.assertEqual(snapshots.policy.retired_versions(versions, active), [])

    # test-category: security
    def test_hosted_clippy_has_its_own_identity_and_exact_producer(self):
        cache = snapshots.cache
        with patch.object(cache, 'output', return_value='rustc 1.99\nhost: x86_64-pc-windows-msvc'), \
                patch.object(cache, 'native_identity', return_value={}), patch.object(cache, 'digest', return_value='locked'), \
                patch.dict(os.environ, {}, clear=True):
            clippy = cache.identity('windows-x64', 'prebuilt-ort', 'clippy')
            self.assertEqual((clippy['profile'], clippy['features']), ('debug', 'workspace-check'))
            for kind in ('native', 'dev'):
                self.assertNotEqual(snapshots.tag_name(clippy),
                                    snapshots.tag_name(cache.identity('windows-x64', 'prebuilt-ort', kind)))
        metadata = dict(run_id=42, sha='a' * 40, producer_name='Windows Clippy check (x86_64-pc-windows-msvc)',
                        identity=clippy)
        run = dict(head_repository={'full_name': 'owner/repo'}, event='push', head_branch='main',
                   head_sha=metadata['sha'], status='completed')
        jobs = [dict(name='windows-check / ' + metadata['producer_name'], status='completed', conclusion='success')]
        with patch.dict(os.environ, GITHUB_REPOSITORY='owner/repo'):
            with patch.object(snapshots, 'api', side_effect=[run, {'jobs': jobs}]):
                snapshots.trusted(metadata)
            self.assertTrue(cache.valid_producer(run, jobs, 'owner/repo', 'windows-x64', 'clippy'))
            for producer in ['Build unsigned Windows preview', 'Windows compile check (x86_64-pc-windows-msvc)']:
                with patch.object(snapshots, 'api', side_effect=[run, {'jobs': jobs}]):
                    with self.assertRaises(snapshots.UnsuccessfulProducer):
                        snapshots.trusted(dict(metadata, producer_name=producer))
                self.assertFalse(cache.valid_producer(run, [dict(jobs[0], name=producer)],
                                                     'owner/repo', 'windows-x64', 'clippy'))


if __name__ == '__main__':
    unittest.main()
