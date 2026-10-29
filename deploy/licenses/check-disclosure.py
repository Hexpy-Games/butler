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
import importlib.util
import io
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import refresh

spec = importlib.util.spec_from_file_location("cargo_notices", Path(__file__).with_name("cargo-notices.py"))
notices = importlib.util.module_from_spec(spec)
spec.loader.exec_module(notices)


class LicensePackaging(unittest.TestCase):
    def test_concurrent_canonical_license_cache_is_never_partial(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            (directory / 'Cargo.toml').write_text('[package]\n', encoding='utf-8', newline='\n')
            package = dict(name='example', version='1.0', license='Apache-2.0',
                           manifest_path=str(directory / 'Cargo.toml'), evidence=[],
                           source='registry+example')
            original = Path.write_text
            observed = []
            writing = False

            def overlapping_write(path, text, *args, **kwargs):
                nonlocal writing
                if writing:
                    return original(path, text, *args, **kwargs)
                writing = True
                # Pause a writer after truncation, before its first byte. A
                # second collector must see a complete entry or fetch its own.
                with path.open('w', encoding='utf-8', newline='\n') as output:
                    observed.append(notices.evidence(package, {})[3][-1][1])
                    return output.write(text)

            with patch.object(refresh.tempfile, 'gettempdir', return_value=temporary), \
                 patch.object(refresh.urllib.request, 'urlopen', side_effect=lambda *a, **k: io.BytesIO(b'Apache License\n')), \
                 patch.object(Path, 'write_text', overlapping_write):
                result = notices.evidence(package, {})
            self.assertEqual(observed, ['Apache License\n'])
            self.assertEqual(result[3][-1][1], 'Apache License\n')

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
