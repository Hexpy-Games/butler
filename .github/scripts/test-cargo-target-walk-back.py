#!/usr/bin/env python3
"""Cargo snapshot restore walk-back and GitHub API transient retry."""
import contextlib
import http.client
import importlib.util
import io
import json
import os
import ssl
import subprocess
from pathlib import Path
import tempfile
import unittest
import urllib.error
from unittest.mock import Mock, call, patch

spec = importlib.util.spec_from_file_location('snapshots', Path(__file__).with_name('cargo-target-release.py'))
snapshots = importlib.util.module_from_spec(spec)
spec.loader.exec_module(snapshots)


class WalkBack(unittest.TestCase):
    lane = dict(schema=2, platform='linux-x64', kind='native', lock='current', configs={'Cargo.toml': 'current'})

    def walk_back(self, states, fetch_error=None, restore_error=None):
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
                patch.object(snapshots, 'restore_tree', side_effect=restore_error) as adopt, contextlib.redirect_stdout(output):
            restored = snapshots.restore(expected)
        self.assertEqual(listing.call_count, int(states[0][2:] != ('completed', 'success')))
        looked_up = [call.args[0].rsplit('--', 1)[-1] for call in lookup.call_args_list[1:]]
        chosen = fetch.call_args.args[1]['name'][:-5] if adopt.called else None
        self.assertEqual(restored, adopt.called and restore_error is None)
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
        self.assertIn('::warning::Cargo snapshot transport failed (RuntimeError: OCI blob failed: manifest unknown); cold Cargo build follows.',
                      output)
        restored, _, _, _, output = self.walk_back(
            [('50-1', self.lane, 'completed', 'success')], fetch_error=pruned)
        self.assertFalse(restored)
        self.assertIn('::warning::', output)

    # test-category: security
    def test_transient_check_error_keeps_a_found_compatible_fallback(self):
        older = dict(self.lane, lock='older', configs={'Cargo.toml': 'older'})
        newest = ('50-1', self.lane, 'in_progress', None)
        states = [newest, ('49-1', older, 'completed', 'success'), ('48-1', self.lane, 'deleted', None)]
        _, chosen, adopted, _, output = self.walk_back(states)
        self.assertEqual((chosen, adopted), ('49-1', (self.lane, True)))
        self.assertIn('Cargo snapshot 48-1 could not be checked (HTTP Error 404: Not Found); keeping', output)
        with self.assertRaises(urllib.error.HTTPError):
            self.walk_back([newest, ('49-1', self.lane, 'deleted', None)])
        fork = dict(older, compiler='other toolchain')  # Trust and identity errors are never swallowed.
        with self.assertRaisesRegex(ValueError, 'identity mismatch'):
            self.walk_back([newest, ('49-1', older, 'completed', 'success'), ('48-1', fork, 'completed', 'success')])

    # test-category: race
    def test_decompression_failure_builds_cold_but_verified_content_errors_fail(self):
        states = [('50-1', self.lane, 'in_progress', None), ('49-1', self.lane, 'completed', 'success')]
        # Exercise restore_tree and extraction with a failing decompressor process.
        restore_tree = snapshots.restore_tree
        real_extract = snapshots.cache.extract
        real_popen = subprocess.Popen

        def failed_decompress(*args, **kwargs):
            return real_popen([snapshots.sys.executable, '-c',
                               "import sys; sys.stdout.buffer.write(bytes(10240)); sys.exit(1)"], **kwargs)

        def extract(directory, **kwargs):
            with patch.object(snapshots.cache.subprocess, 'Popen', side_effect=failed_decompress):
                real_extract(directory, **kwargs)

        with tempfile.TemporaryDirectory() as temporary, \
                patch.dict(os.environ, CARGO_TARGET_DIR=str(Path(temporary) / 'target')), \
                patch.object(snapshots.cache, 'verify'), patch.object(snapshots.cache, 'extract', side_effect=extract):
            restored, _, _, _, output = self.walk_back(states, restore_error=restore_tree)
        self.assertFalse(restored)
        self.assertIn('::warning::Cargo snapshot decompress failed (RuntimeError:', output)
        self.assertIn('Cargo build-cache decompression failed', output)
        self.assertIn('cold Cargo build follows.', output)
        for error in ['digest mismatch', 'identity mismatch', 'Non-NUL archive tail']:
            with self.assertRaisesRegex(ValueError, error):
                self.walk_back(states, restore_error=ValueError(error))

    # test-category: pure-logic
    def test_local_filesystem_errors_propagate_and_transport_errors_warn(self):
        states = [('50-1', self.lane, 'completed', 'success')]
        error = OSError('local path failure')
        for phase in ['persistent_target', 'restore_local']:
            with patch.object(snapshots, 'persistent_target', return_value=Path('local')), \
                    patch.object(snapshots, phase, side_effect=error), self.assertRaises(OSError):
                self.walk_back(states)
        with self.assertRaises(OSError):
            self.walk_back(states, restore_error=error)
        restored, _, _, _, output = self.walk_back(states, fetch_error=OSError('connection closed'))
        self.assertFalse(restored)
        self.assertIn('::warning::Cargo snapshot transport failed (OSError: connection closed)', output)

    # test-category: pure-logic
    def test_extract_errors_fall_back_only_for_decompression(self):
        states = [('50-1', self.lane, 'completed', 'success')]
        restore_tree = snapshots.restore_tree
        with tempfile.TemporaryDirectory() as temporary, \
                patch.dict(os.environ, CARGO_TARGET_DIR=str(Path(temporary) / 'target')), \
                patch.object(snapshots.cache, 'verify'):
            for error in [snapshots.tarfile.ReadError('invalid tar'), EOFError('truncated stream')]:
                with self.subTest(error=type(error).__name__), \
                        patch.object(snapshots.cache, 'extract', side_effect=error):
                    restored, _, _, _, output = self.walk_back(states, restore_error=restore_tree)
                self.assertFalse(restored)
                self.assertIn(f'::warning::Cargo snapshot decompress failed ({type(error).__name__}: {error})', output)
            for phase in ['delete_tree', 'extract', 'rename']:
                owner = {'delete_tree': snapshots.runner_cache, 'extract': snapshots.cache, 'rename': os}[phase]
                with patch.object(snapshots.cache, 'extract'), \
                        patch.object(owner, phase, side_effect=OSError('local path failure')), \
                        self.assertRaisesRegex(OSError, 'local path failure'):
                    self.walk_back(states, restore_error=restore_tree)

    # test-category: security
    def test_generation_tag_must_name_its_producer_run(self):
        generation = dict(metadata=dict(identity=self.lane, run_id=48, run_attempt=1), chunks=[])
        with tempfile.TemporaryDirectory() as temporary, \
                patch.object(snapshots, 'download', side_effect=lambda _, path: path.write_text(json.dumps(generation))), \
                patch.object(snapshots, 'trusted', side_effect=AssertionError('trust lookup')):
            for name in ['49-1.json', '48-2.json']:
                with self.assertRaisesRegex(ValueError, 'does not match its producer run'):
                    snapshots.checked_generation({'name': name}, Path(temporary), self.lane, None)


class ApiRetry(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch.dict(os.environ, GITHUB_TOKEN='test-token'))
        self.urlopen = self.enterContext(patch.object(snapshots.urllib.request, 'urlopen'))
        self.sleep = self.enterContext(patch.object(snapshots.time, 'sleep'))
        self.output = self.enterContext(contextlib.redirect_stdout(io.StringIO()))

    def response(self, value, link=''):
        response = io.BytesIO(json.dumps(value).encode())
        response.headers = {'Link': link}
        return response

    def http_error(self, code):
        return urllib.error.HTTPError('https://api.github.com/resource', code, 'failed', {}, None)

    # test-category: pure-logic
    def test_transient_http_classification(self):
        transient = [TimeoutError(), ConnectionResetError(), http.client.RemoteDisconnected(),
                     http.client.IncompleteRead(b'partial'), urllib.error.URLError(TimeoutError())]
        transient += [self.http_error(code) for code in [500, 502, 503, 429]]
        permanent = [self.http_error(code) for code in [401, 403, 404, 422]]
        permanent += [urllib.error.URLError(ssl.SSLCertVerificationError('certificate failed')),
                      urllib.error.URLError('string reason'), ValueError(), KeyError(),
                      ssl.SSLCertVerificationError('certificate failed'), ssl.SSLError('SSL failed')]
        for expected, errors in [(True, transient), (False, permanent)]:
            for error in errors:
                with self.subTest(error=repr(error)):
                    self.assertEqual(snapshots.transient_http(error), expected)

    # test-category: pure-logic
    def test_paginated_get_retries_body_timeout_without_losing_entries(self):
        next_url = 'https://api.github.com/resource?page=2'
        broken = self.response([])
        broken.read = Mock(side_effect=TimeoutError('body read timed out'))
        self.urlopen.side_effect = [self.response([{'id': 1}], f'<{next_url}>; rel="next"'),
                                   broken, self.response([{'id': 2}, {'id': 3}])]
        self.assertEqual(snapshots.api('resource'), [{'id': 1}, {'id': 2}, {'id': 3}])
        self.assertEqual([entry.args[0].full_url for entry in self.urlopen.call_args_list],
                         ['https://api.github.com/resource', next_url, next_url])
        self.assertTrue(all(entry.kwargs == {'timeout': 60} for entry in self.urlopen.call_args_list))
        self.assertEqual(self.sleep.call_args_list, [call(2)])
        self.assertEqual(self.output.getvalue(), 'GitHub API request failed (TimeoutError: body read timed out); '
                         'retrying in 2 s (attempt 2 of 3).\n')

    # test-category: pure-logic
    def test_three_timeouts_propagate_the_last_exception(self):
        errors = [TimeoutError('first'), TimeoutError('second'), TimeoutError('last')]
        self.urlopen.side_effect = errors
        with self.assertRaises(TimeoutError) as raised:
            snapshots.api('resource')
        self.assertIs(raised.exception, errors[-1])
        self.assertEqual(self.urlopen.call_count, 3)
        self.assertEqual(self.sleep.call_args_list, [call(2), call(8)])
        self.assertIn('retrying in 8 s (attempt 3 of 3).', self.output.getvalue())

    # test-category: pure-logic
    def test_http_403_fails_immediately(self):
        error = self.http_error(403)
        self.urlopen.side_effect = error
        with self.assertRaises(urllib.error.HTTPError) as raised:
            snapshots.api('resource')
        self.assertIs(raised.exception, error)
        self.assertEqual(self.urlopen.call_count, 1)
        self.sleep.assert_not_called()
        self.assertEqual(self.output.getvalue(), '')

    # test-category: pure-logic
    def test_delete_retry_accepts_404(self):
        self.urlopen.side_effect = [TimeoutError('timed out'), self.http_error(404)]
        self.assertIsNone(snapshots.api('resource', method='DELETE'))
        self.assertEqual(self.urlopen.call_count, 2)
        self.assertTrue(all(entry.args[0].method == 'DELETE' for entry in self.urlopen.call_args_list))
        self.assertEqual(self.sleep.call_args_list, [call(2)])

    # test-category: pure-logic
    def test_delete_first_404_raises(self):
        error = self.http_error(404)
        self.urlopen.side_effect = error
        with self.assertRaises(urllib.error.HTTPError) as raised:
            snapshots.api('resource', method='DELETE')
        self.assertIs(raised.exception, error)
        self.assertEqual(self.urlopen.call_count, 1)
        self.sleep.assert_not_called()


if __name__ == '__main__':
    unittest.main()
