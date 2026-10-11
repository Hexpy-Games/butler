#!/usr/bin/env python3
"""The Linux helper extends the immutable archive layout without relaxing extraction."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[2] / 'packages/butler-agent/rust/scripts/release-standalone-agent.py'
SPEC = importlib.util.spec_from_file_location('native_archive', SCRIPT)
native = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(native)


def fixture(path, platform='linux', kind='file', mode=0o555, checksum=None):
    helper = b'complete sandbox helper fixture'
    architecture = 'arm64' if platform == 'darwin' else 'x64'
    manifest = dict(schema=native.packager.SCHEMA, platform=platform, architecture=architecture,
                    binary='butler-agent', launcher='butler', resources='resources',
                    sandboxSha256=checksum or hashlib.sha256(helper).hexdigest())
    with tarfile.open(path, 'w:gz') as archive:
        for name, content in [('butler-agent', b'agent'),
                              ('native-agent-manifest.json', json.dumps(manifest).encode())]:
            entry = tarfile.TarInfo(name)
            entry.size, entry.mode = len(content), 0o555
            archive.addfile(entry, io.BytesIO(content))
        entry = tarfile.TarInfo('resources')
        entry.type = tarfile.DIRTYPE
        archive.addfile(entry)
        entry = tarfile.TarInfo('butler')
        entry.type, entry.linkname = tarfile.SYMTYPE, 'butler-agent'
        archive.addfile(entry)
        if kind != 'absent':
            entry = tarfile.TarInfo('butler-sandbox')
            entry.mode = mode
            if kind == 'file':
                entry.size = len(helper)
                archive.addfile(entry, io.BytesIO(helper))
            else:
                entry.type = {'symlink': tarfile.SYMTYPE, 'hardlink': tarfile.LNKTYPE,
                              'directory': tarfile.DIRTYPE}[kind]
                entry.linkname = 'butler-agent'
                archive.addfile(entry)


class NativeArchiveSafety(unittest.TestCase):
    # test-category: security
    def test_linux_helper_is_complete_and_macos_keeps_its_layout(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for platform, kind in [('linux', 'file'), ('darwin', 'absent')]:
                archive, destination = root / f'{platform}.tgz', root / platform
                destination.mkdir()
                fixture(archive, platform, kind)
                native._extract_archive(archive, destination)
                if platform == 'linux':
                    helper = destination / 'butler-sandbox'
                    self.assertEqual(helper.read_bytes(), b'complete sandbox helper fixture')
                    self.assertEqual(helper.stat().st_mode & 0o7777, 0o555)
                else:
                    self.assertFalse((destination / 'butler-sandbox').exists())

    # test-category: security
    def test_missing_aliased_writable_and_non_linux_helpers_are_rejected_before_extraction(self):
        cases = [('linux', 'absent', 0o555), ('linux', 'symlink', 0o555),
                 ('linux', 'hardlink', 0o555), ('linux', 'directory', 0o555),
                 ('linux', 'file', 0o755), ('linux', 'file', 0o4555),
                 ('linux', 'file', 0o444), ('darwin', 'file', 0o555)]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for index, (platform, kind, mode) in enumerate(cases):
                with self.subTest(platform=platform, kind=kind, mode=mode):
                    archive, destination = root / f'{index}.tgz', root / str(index)
                    destination.mkdir()
                    fixture(archive, platform, kind, mode)
                    with self.assertRaises(SystemExit):
                        native._extract_archive(archive, destination)
                    self.assertEqual(list(destination.iterdir()), [])

    # test-category: security
    def test_helper_checksum_mismatch_stops_before_any_command_executes(self):
        with tempfile.TemporaryDirectory() as temporary:
            archive = Path(temporary) / 'corrupt-helper.tgz'
            fixture(archive, checksum='0' * 64)
            # ELF validation is separate; this case isolates the trust decision
            # and proves a corrupt helper cannot reach an Agent command.
            with patch.object(native.packager, 'verify_binary'), \
                 patch.object(native.subprocess, 'run', side_effect=AssertionError('unexpected exec')):
                with self.assertRaisesRegex(SystemExit, 'sandbox checksum mismatch'):
                    native.archive_smoke(archive)


if __name__ == '__main__':
    unittest.main()
