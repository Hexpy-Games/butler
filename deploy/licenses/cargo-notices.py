#!/usr/bin/env python3
"""Package locked Cargo runtime/build dependencies using the reviewed license policy.

Unlike the App catalog generator, this accepts any Cargo workspace and writes
full source evidence beside its notices, without changing the App inventory.
"""
import argparse
import concurrent.futures
import re
import json
import subprocess
from pathlib import Path

from refresh import fetch, license_files


def cargo(root, *args):
    return subprocess.check_output(['cargo', *args, '--locked'], cwd=root, text=True)


def collect(root, target):
    metadata = json.loads(cargo(root, 'metadata', '--format-version', '1',
                                '--filter-platform', target))
    tree = cargo(root, 'tree', '--workspace', '--target', target, '-e', 'normal,build',
                 '--prefix', 'none', '--format', '{p}')
    identities = {tuple(line.split()[:2]) for line in tree.splitlines()}
    packages = [p for p in metadata['packages'] if p['source'] and
                (p['name'], 'v' + p['version']) in identities]
    siblings = {}
    for package in packages:
        directory = Path(package['manifest_path']).parent
        files = license_files(directory)
        # Git workspace crates commonly inherit the repository-root license.
        checkout = next((p for p in directory.parents if (p / '.git').exists()), None)
        if not files and checkout:
            files = [(p.name, p.read_text(encoding='utf-8')) for p in checkout.iterdir()
                     if p.is_file() and p.name.upper().startswith(('LICENSE', 'COPYING', 'NOTICE'))]
        repository = (package.get('repository') or '').rstrip('/')
        if files and repository:
            siblings.setdefault(repository, files)
        package['evidence'] = files
    packages.sort(key=lambda p: (p['name'], p['version'], p['source']))
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        return list(pool.map(lambda package: evidence(package, siblings), packages))


def evidence(package, siblings):
    directory = Path(package['manifest_path']).parent
    license_id = package['license']
    files = package['evidence'] or siblings.get((package.get('repository') or '').rstrip('/'), [])
    if not license_id:
        texts = '\n'.join(text for _, text in files)
        if 'UNICODE LICENSE V3' in texts:
            license_id = 'Unicode-3.0'
        elif 'MIT License' in texts and 'Permission is hereby granted, free of charge' in texts:
            license_id = 'MIT'
        elif 'Apache License' in texts and 'Version 2.0, January 2004' in texts:
            license_id = 'Apache-2.0'
    if not files:
        # Some published crates omit their declared license files. Preserve the
        # exact declaration, plus canonical texts, without inventing attribution.
        if not license_id:
            raise ValueError(f"Missing license declaration: {package['name']}")
        files = [('Cargo.toml', (directory / 'Cargo.toml').read_text(encoding='utf-8'))]
        for identifier in sorted(set(re.findall(r'[A-Za-z0-9][A-Za-z0-9.-]*', license_id)) - {'OR', 'AND', 'WITH'}):
            url = f'https://raw.githubusercontent.com/spdx/license-list-data/v3.27.0/text/{identifier}.txt'
            text = fetch(url)
            if not text:
                raise ValueError(f'Missing canonical license text: {identifier}')
            files.append((f'{identifier}.txt', text))
    source = package['source']
    if source.startswith('registry+'):
        source = f"https://crates.io/crates/{package['name']}/{package['version']}"
    return package, license_id, source, files


def write_notices(evidence, destination):
    components = [dict(id=f"rust:{p['name']}@{p['version']}", license=license_id)
                  for p, license_id, _, _ in evidence]
    # Reuse the reviewed SPDX allowlist and version-scoped MPL exceptions.
    policy = "import {validateLicense} from './deploy/licenses/generate.mjs'; " \
             "let s=''; for await (const c of process.stdin) s+=c; " \
             "JSON.parse(s).forEach(validateLicense);"
    subprocess.run(['node', '--input-type=module', '-e', policy],
                   cwd=Path(__file__).resolve().parents[2], input=json.dumps(components),
                   text=True, check=True)
    destination.mkdir(parents=True, exist_ok=True)
    sections = ['Experimental shell third-party notices',
                'Locked runtime and build dependencies; full license evidence in licenses/.']
    for package, license_id, source, files in evidence:
        if not files or any(not text or not text.strip() for _, text in files):
            raise ValueError(f"Missing license evidence: {package['name']} {package['version']}")
        folder = destination / 'licenses' / f"{package['name']}-{package['version']}"
        folder.mkdir(parents=True, exist_ok=True)
        sections.append(f"\n{package['name']} {package['version']}\n{license_id}\n{source}")
        for index, (label, text) in enumerate(files):
            name = folder / f'{index:03d}-{Path(label).name}'
            name.write_text(text, encoding='utf-8')
            sections.append(f'License: {name.relative_to(destination).as_posix()}')
    (destination / 'THIRD-PARTY-NOTICES').write_text('\n'.join(sections) + '\n', encoding='utf-8')
    print(f'Packaged license evidence for {len(evidence)} Cargo dependencies')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--target', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    write_notices(collect(args.root.resolve(), args.target), args.output.resolve())


if __name__ == '__main__':
    main()
