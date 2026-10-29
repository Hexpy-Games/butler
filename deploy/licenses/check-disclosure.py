"""Offline attribution extraction fixtures."""
from disclosure import copyrights

# test-category: pure-logic
assert copyrights(["Copyright Mozilla Foundation\n\nPermission is hereby granted"]) == ["Copyright Mozilla Foundation"]
assert copyrights(["Copyright JS Foundation and other contributors, https://js.foundation/"]) == ["Copyright JS Foundation and other contributors, https://js.foundation/"]
assert copyrights(["Copyright (c) 2023\n  - Example Author.\n\nPermission is hereby granted"]) == ["Copyright (c) 2023", "- Example Author."]
assert copyrights(["Copyright 2001-2023 Xiph.Org,\n    Jean-Marc Valin,\n    Timothy B. Terriberry\n\nRedistribution..."]) == ["Copyright 2001-2023 Xiph.Org,", "Jean-Marc Valin,", "Timothy B. Terriberry"]
assert copyrights(["Copyright [yyyy] [name of copyright owner]\nThe above copyright notice must remain"]) == []
assert copyrights(["Copyright Holder may include your modifications in the Standard"]) == []
print("Dated, undated and wrapped attribution fixtures passed")

# test-category: race
import concurrent.futures
import importlib.util
import io
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

import refresh

spec = importlib.util.spec_from_file_location("cargo_notices", Path(__file__).with_name("cargo-notices.py"))
notices = importlib.util.module_from_spec(spec)
spec.loader.exec_module(notices)


class LicensePackaging(unittest.TestCase):
    def setUp(self):
        # Each fixture models a fresh collector process.
        self.futures = patch.object(refresh, 'FETCHES', {})
        self.futures.start()
        self.addCleanup(self.futures.stop)

    # test-category: race
    def test_concurrent_fetch_shares_one_network_result(self):
        for missing in (False, True):
            with self.subTest(missing=missing), tempfile.TemporaryDirectory() as temporary:
                url = f'https://example.org/license/{missing}'
                start = threading.Barrier(32)
                entered = threading.Event()
                release = threading.Event()

                def network(*args, **kwargs):
                    entered.set()
                    if not release.wait(10):
                        raise TimeoutError('network stub was not released')
                    if missing:
                        error = refresh.urllib.error.HTTPError(url, 404, 'missing', {}, io.BytesIO())
                        self.addCleanup(error.close)
                        raise error
                    return io.BytesIO(b'Complete license\n')

                def fetch():
                    start.wait(timeout=10)
                    return refresh.fetch(url)

                with patch.object(refresh.tempfile, 'gettempdir', return_value=temporary), \
                     patch.object(refresh.urllib.request, 'urlopen', side_effect=network) as request, \
                     concurrent.futures.ThreadPoolExecutor(max_workers=32) as pool:
                    results = [pool.submit(fetch) for _ in range(32)]
                    try:
                        self.assertTrue(entered.wait(10))
                    finally:
                        release.set()
                    expected = None if missing else 'Complete license\n'
                    self.assertEqual([result.result(timeout=10) for result in results], [expected] * 32)
                    self.assertEqual(refresh.fetch(url), expected)
                    self.assertEqual(request.call_count, 1)

    # test-category: race
    def test_failed_fetch_is_shared_without_retry(self):
        with tempfile.TemporaryDirectory() as temporary:
            url = 'https://example.org/unavailable'
            error = refresh.urllib.error.HTTPError(url, 503, 'unavailable', {}, io.BytesIO())
            self.addCleanup(error.close)
            with patch.object(refresh.tempfile, 'gettempdir', return_value=temporary), \
                 patch.object(refresh.urllib.request, 'urlopen', side_effect=error) as request, \
                 concurrent.futures.ThreadPoolExecutor(max_workers=32) as pool:
                results = [pool.submit(refresh.fetch, url) for _ in range(32)]
                exceptions = [result.exception(timeout=10) for result in results]
                self.assertIsInstance(exceptions[0], RuntimeError)
                self.assertIn('HTTP 503', str(exceptions[0]))
                self.assertTrue(all(error is exceptions[0] for error in exceptions))
                self.assertEqual(request.call_count, 1)
            self.assertEqual(list((Path(temporary) / 'butler-license-evidence').iterdir()), [])

    # test-category: race
    def test_atomic_cache_preserves_complete_entry_during_write(self):
        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary) / 'license'
            destination.write_text('old complete license', encoding='utf-8')

            def overlapping_write(path, text, *args, **kwargs):
                with path.open('w', encoding='utf-8') as output:
                    self.assertEqual(destination.read_text(encoding='utf-8'), 'old complete license')
                    return output.write(text)

            with patch.object(Path, 'write_text', overlapping_write):
                refresh.cache_text(destination, 'new complete license')
            self.assertEqual(destination.read_text(encoding='utf-8'), 'new complete license')
            self.assertEqual(list(Path(temporary).iterdir()), [destination])

    # test-category: race
    def test_replace_denied_uses_other_process_entry(self):
        for existing in ('other complete license\n', ''):
            with self.subTest(existing=existing), tempfile.TemporaryDirectory() as temporary:
                destination = Path(temporary) / 'license'

                def replace(source, target):
                    target.write_text(existing, encoding='utf-8')
                    raise PermissionError('destination open for reading')

                with patch.object(Path, 'replace', replace):
                    self.assertEqual(refresh.cache_text(destination, 'downloaded'), existing)
                self.assertEqual(destination.read_text(encoding='utf-8'), existing)
                self.assertEqual(list(Path(temporary).iterdir()), [destination])

    # test-category: pure-logic
    def test_replace_errors_without_complete_entry_propagate(self):
        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary) / 'license'
            for error in (PermissionError('no entry'), OSError('disk failure')):
                with self.subTest(error=error), patch.object(Path, 'replace', side_effect=error):
                    with self.assertRaises(type(error)):
                        refresh.cache_text(destination, 'downloaded')
                    self.assertEqual(list(Path(temporary).iterdir()), [])
            destination.write_text('complete', encoding='utf-8')
            with patch.object(Path, 'replace', side_effect=OSError('disk failure')):
                with self.assertRaises(OSError):
                    refresh.cache_text(destination, 'downloaded')

    # test-category: pure-logic
    def test_utf8_files_and_cargo_output_under_cp1252_default(self):
        original = io.open

        def cp1252_open(file, mode='r', buffering=-1, encoding=None, errors=None,
                        newline=None, **kwargs):
            if 'b' not in mode and encoding in (None, 'locale'):
                encoding = 'cp1252'
            if 'w' in mode and 'b' not in mode and newline is None:
                newline = '\r\n'
            return original(file, mode, buffering, encoding, errors, newline, **kwargs)

        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            text = 'Copyright \u0101\n'
            (directory / 'LICENSE').write_bytes(text.encode('utf-8'))
            url = 'https://example.org/license'
            cache = directory / 'butler-license-evidence'
            cache.mkdir()
            (cache / refresh.digest(url.encode())).write_bytes(text.encode('utf-8'))
            with patch('io.open', cp1252_open), \
                 patch.object(subprocess, '_text_encoding', return_value='cp1252'), \
                 patch.object(refresh.tempfile, 'gettempdir', return_value=temporary):
                self.assertEqual(refresh.fetch(url), text)
                self.assertEqual(refresh.license_files(directory)[0][1], text)
                refresh.cache_text(cache / 'new-license', text)
                self.assertEqual((cache / 'new-license').read_bytes(), text.encode('utf-8'))
                child = "import sys; sys.stdout.buffer.write('\\u0101'.encode('utf-8'))"
                self.assertEqual(refresh.run(sys.executable, '-c', child), '\u0101')
                with patch.object(notices.subprocess, 'check_output', wraps=subprocess.check_output) as output:
                    # Exercise the real decoder, substituting a tiny child for Cargo.
                    def child_output(command, **kwargs):
                        return subprocess.run([sys.executable, '-c', child], stdout=subprocess.PIPE,
                                              **kwargs).stdout
                    output.side_effect = child_output
                    self.assertEqual(notices.cargo(directory, 'metadata'), '\u0101')
                package = dict(name='example', version='1.0')
                notices.write_notices([(package, 'MIT', url, [('LICENSE', text)])], directory / 'out')
            self.assertEqual((directory / 'out/licenses/example-1.0/000-LICENSE').read_bytes(), text.encode('utf-8'))
            self.assertNotIn(b'\r', (directory / 'out/THIRD-PARTY-NOTICES').read_bytes())


if __name__ == '__main__':
    unittest.main()
