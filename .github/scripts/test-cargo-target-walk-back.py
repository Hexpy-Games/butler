#!/usr/bin/env python3
"""Cargo snapshot restore walk-back past unfinished or failed producers."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
import urllib.error
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('snapshots', Path(__file__).with_name('cargo-target-release.py'))
snapshots = importlib.util.module_from_spec(spec)
spec.loader.exec_module(snapshots)


class WalkBack(unittest.TestCase):
    lane = dict(schema=2, platform='linux-x64', kind='native', lock='current', configs={'Cargo.toml': 'current'})

    def walk_back(self, states, fetch_error=None):
        """Restore from generations newest first: (suffix, identity, run status, job conclusion)."""
        expected = self.lane
        generations = {suffix: dict(metadata=dict(identity=identity, run_id=int(suffix.split('-')[0]), run_attempt=1,
                                                  sha=suffix * 8, producer_name='Build native Agent (linux-x64)'),
                                    chunks=[suffix + '-0000.zst'])
                       for suffix, identity, _, _ in states}
        runs = {int(suffix.split('-')[0]): (status, conclusion) for suffix, _, status, conclusion in states}
        prefix = snapshots.compatible_tag(expected) + '--'

        def release(tag):
            if tag == snapshots.tag_name(expected):
                return {'assets': [{'name': states[0][0] + '.json'}]}
            suffix = tag.removeprefix(prefix)
            return {'assets': [{'name': suffix + '.json'}]} if suffix in generations else None

        def download(entry, destination):
            destination.write_text(json.dumps(generations[entry['name'][:-5]]))

        def api(endpoint):
            run_id = int(endpoint.split('/runs/')[1].split('/')[0])
            status, conclusion = runs[run_id]
            if status == 'deleted':
                raise urllib.error.HTTPError(endpoint, 404, 'Not Found', {}, io.BytesIO())
            if '/jobs?' in endpoint:
                return {'jobs': [dict(name='linux-native / Build native Agent (linux-x64)',
                                      status=status, conclusion=conclusion)]}
            return dict(head_repository={'full_name': 'owner/repo'}, event='push', head_branch='main',
                        head_sha=generations[f'{run_id}-1']['metadata']['sha'], status=status)

        tags = [prefix + suffix for suffix in generations] + [prefix[:-2], 'compatible-other-key--99-1']
        output = io.StringIO()
        with tempfile.TemporaryDirectory() as temporary, \
                patch.dict(os.environ, RUNNER_TEMP=temporary, GITHUB_REPOSITORY='owner/repo'), \
                patch.object(snapshots, 'release', side_effect=release) as lookup, \
                patch.object(snapshots, 'download', side_effect=download), \
                patch.object(snapshots, 'api', side_effect=api), \
                patch.object(snapshots.ci_oci, 'tags', return_value=tags) as listing, \
                patch.object(snapshots, 'fetch_chunks', side_effect=fetch_error) as fetch, \
                patch.object(snapshots, 'restore_tree') as adopt, contextlib.redirect_stdout(output):
            restored = snapshots.restore(expected)
        self.assertEqual(listing.call_count, 1)
        looked_up = [call.args[0].rsplit('--', 1)[-1] for call in lookup.call_args_list[1:]]
        chosen = fetch.call_args.args[1]['name'][:-5] if adopt.called else None
        self.assertEqual(restored, adopt.called)
        return restored, chosen, adopt.call_args.args[1:] if adopt.called else None, looked_up, output.getvalue()

    # test-category: security
    def test_restore_walks_back_to_the_newest_finished_green_generation(self):
        expected = self.lane
        older = dict(expected, lock='older', configs={'Cargo.toml': 'older'})
        green = ('completed', 'success')
        newest = ('50-1', expected, 'in_progress', None)
        # Unfinished newest, newer compatible green, failed exact, exact green, then one past the cap.
        states = [newest, ('49-1', older, *green), ('48-1', expected, 'completed', 'failure'),
                  ('47-1', expected, *green), ('46-1', expected, *green)]
        _, chosen, adopted, looked_up, output = self.walk_back(states)
        self.assertEqual((chosen, adopted), ('47-1', (expected, False)))
        self.assertEqual(looked_up, ['49-1', '48-1', '47-1'])  # Newest first, other keys ignored.
        self.assertIn('Newest Cargo snapshot 50-1 skipped: Cargo snapshot producer is not complete yet', output)
        self.assertIn('Cargo snapshot 48-1 skipped: Cargo snapshot producer lane did not succeed', output)
        self.assertIn('Checking the newest 3 of 4 older Cargo snapshots.', output)
        self.assertIn('Selected Cargo snapshot 47-1 (run 47 attempt 1, exact identity)', output)
        # Without an exact green generation inside the cap, the newest compatible green one wins.
        states[3] = ('47-1', expected, 'completed', 'cancelled')
        _, chosen, adopted, looked_up, _ = self.walk_back(states)
        self.assertEqual((chosen, adopted), ('49-1', (expected, True)))
        self.assertEqual(looked_up, ['49-1', '48-1', '47-1'])  # 46-1 lies past the lookup cap.
        # Never an unfinished or failed producer: no green generation means a cold build.
        states = [newest, ('49-1', older, 'in_progress', None), ('48-1', expected, 'completed', 'failure')]
        restored, chosen, adopted, _, output = self.walk_back(states)
        self.assertEqual((restored, chosen), (False, None))
        self.assertIn('No finished green Cargo snapshot for this lane; cold Cargo build follows.', output)

    # test-category: security
    def test_restore_walk_back_rejects_a_foreign_identity_under_the_key(self):
        states = [('50-1', self.lane, 'in_progress', None),
                  ('49-1', dict(self.lane, compiler='other toolchain'), 'completed', 'success')]
        with self.assertRaisesRegex(ValueError, 'identity mismatch'):
            self.walk_back(states)

    # test-category: security
    def test_walk_back_choice_pruned_mid_download_builds_cold(self):
        states = [('50-1', self.lane, 'in_progress', None), ('49-1', self.lane, 'completed', 'success')]
        pruned = RuntimeError('OCI blob failed: manifest unknown')
        restored, _, _, _, output = self.walk_back(states, fetch_error=pruned)
        self.assertFalse(restored)
        self.assertIn('Cargo snapshot 49-1 download failed (OCI blob failed: manifest unknown); cold Cargo build follows.',
                      output)
        with self.assertRaisesRegex(RuntimeError, 'manifest unknown'):  # The tagged generation still fails loudly.
            self.walk_back([('50-1', self.lane, 'completed', 'success')], fetch_error=pruned)

    # test-category: security
    def test_transient_check_error_keeps_a_found_compatible_fallback(self):
        older = dict(self.lane, lock='older', configs={'Cargo.toml': 'older'})
        newest = ('50-1', self.lane, 'in_progress', None)
        states = [newest, ('49-1', older, 'completed', 'success'), ('48-1', self.lane, 'deleted', None)]
        _, chosen, adopted, _, output = self.walk_back(states)
        self.assertEqual((chosen, adopted), ('49-1', (self.lane, True)))
        self.assertIn('Cargo snapshot 48-1 could not be checked (HTTP Error 404: Not Found); keeping', output)
        with self.assertRaises(urllib.error.HTTPError):  # Without a fallback the error is not hidden.
            self.walk_back([newest, ('49-1', self.lane, 'deleted', None)])
        fork = dict(older, compiler='other toolchain')  # Trust and identity errors are never swallowed.
        with self.assertRaisesRegex(ValueError, 'identity mismatch'):
            self.walk_back([newest, ('49-1', older, 'completed', 'success'), ('48-1', fork, 'completed', 'success')])

    # test-category: security
    def test_generation_tag_must_name_its_producer_run(self):
        generation = dict(metadata=dict(identity=self.lane, run_id=48, run_attempt=1), chunks=[])
        with tempfile.TemporaryDirectory() as temporary, \
                patch.object(snapshots, 'download', side_effect=lambda _, path: path.write_text(json.dumps(generation))), \
                patch.object(snapshots, 'trusted', side_effect=AssertionError('trust lookup')):
            for name in ['49-1.json', '48-2.json']:
                with self.assertRaisesRegex(ValueError, 'does not match its producer run'):
                    snapshots.checked_generation({'name': name}, Path(temporary), self.lane, None)


if __name__ == '__main__':
    unittest.main()
