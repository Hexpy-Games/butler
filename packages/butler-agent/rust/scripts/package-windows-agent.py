#!/usr/bin/env python3
"""Package a Windows x64 executable and renderer using the shared manifests."""
import argparse
import gzip
import importlib.util
import json
from pathlib import Path
import re
import shutil
import struct
import subprocess
import tempfile
import zipfile

spec = importlib.util.spec_from_file_location('packager', Path(__file__).with_name('package-standalone-agent.py'))
packager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packager)


def verify_pe(binary):
    data = binary.read_bytes()
    if data[:2] != b'MZ':
        raise SystemExit('Not a Windows executable')
    offset = struct.unpack_from('<I', data, 60)[0]
    if data[offset:offset + 4] != b'PE\0\0' or struct.unpack_from('<H', data, offset + 4)[0] != 0x8664:
        raise SystemExit('Not a Windows x64 executable')


def binary_version(binary):
    output = subprocess.check_output([str(binary.resolve()), '--version'], text=True).strip()
    match = re.fullmatch(r'butler (\S+) \([0-9a-f]{8}\)', output)
    if not match:
        raise SystemExit('Agent release version unavailable')
    return match.group(1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', required=True, type=Path)
    parser.add_argument('--resources', required=True, type=Path)
    parser.add_argument('--renderer', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--artifact-base-url', required=True)
    parser.add_argument('--channel', default='preview')
    args = parser.parse_args()
    verify_pe(args.binary)
    version = binary_version(args.binary)
    args.output.mkdir(parents=True, exist_ok=True)
    archive = args.output / f'butler-agent-{version}-windows-x64.zip'
    with tempfile.TemporaryDirectory() as temp:
        stage = Path(temp)
        shutil.copyfile(args.binary, stage / 'butler-agent.exe')
        packager.validate_resource_symlinks(args.resources.resolve())
        shutil.copytree(args.resources, stage / 'resources', symlinks=False)
        renderer = stage / 'resources/app-client/dist'
        shutil.rmtree(renderer, ignore_errors=True)
        shutil.copytree(args.renderer, renderer)
        notices = renderer / 'THIRD_PARTY_NOTICES.txt.gz'
        if not notices.is_file() or not gzip.decompress(notices.read_bytes()):
            raise SystemExit('Renderer license notices missing')
        (stage / 'THIRD_PARTY_NOTICES.txt').write_text(
            'Complete notices: resources/app-client/dist/THIRD_PARTY_NOTICES.txt.gz\n'
            'Open Settings > About > Open source licenses in the browser UI.\n', encoding='utf-8')
        (stage / 'butler.cmd').write_bytes(
            b'@echo off\r\nREM butler-native-launcher v1\r\n'
            b'"%~dp0butler-agent.exe" --installation-root "%~dp0." --resource-root "%~dp0resources" %*\r\n')
        manifest = dict(schema=packager.SCHEMA, version=version, appVersion=None,
                        platform='win32', architecture='x64', binary='butler-agent.exe',
                        resources='resources', launcher='butler.cmd',
                        binarySha256=packager.sha256_file(stage / 'butler-agent.exe'),
                        resourcesSha256=packager.sha256_tree(stage / 'resources'))
        (stage / 'native-agent-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
        with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED) as target:
            for path in sorted(stage.rglob('*')):
                if path.is_file():
                    info = zipfile.ZipInfo(path.relative_to(stage).as_posix(), (1980, 1, 1, 0, 0, 0))
                    info.compress_type = zipfile.ZIP_DEFLATED
                    target.writestr(info, path.read_bytes())
    packager.write_agent_manifests(archive, version=version, app_version=None,
                                  target='windows-x64', channel=args.channel,
                                  artifact_url=args.artifact_base_url.rstrip('/') + '/' + archive.name)
    digest = packager.sha256_file(archive)
    (args.output / (archive.name + '.sha256')).write_text(f'{digest}  {archive.name}\n', encoding='utf-8')
    # Also consumed by the isolated installer smoke before consolidated release sums exist.
    (args.output / f'butler-{version}-SHA256SUMS').write_text(f'{digest}  {archive.name}\n', encoding='utf-8')
    print(archive)


if __name__ == '__main__':
    main()
