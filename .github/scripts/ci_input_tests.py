"""Dependency-derived selector regressions, run by test-ci-changes.py."""
import glob
import importlib.util
import json
from pathlib import Path
import re
import tempfile
import unittest

import ci_rust_inputs

ROOT = Path(__file__).resolve().parents[2]
UI = ROOT / 'packages/butler-app/client/ui'
SPEC = importlib.util.spec_from_file_location('input_changes', ROOT / '.github/scripts/ci-changes.py')
changes = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(changes)


def local_imports(source):
    text = source.read_text(encoding='utf-8')
    aliases = json.loads((UI / 'tsconfig.json').read_text())['compilerOptions']['paths']
    refs = re.findall(r'''(?:\bfrom\s*|\bimport\s*|\bimport\s*\(|\brequire\s*\(|\bglob\s*\(|\bsrc=)["']([^"']+)["']''', text)
    for ref in refs:
        base = source.parent / ref.split('?')[0]
        for alias, targets in aliases.items():
            prefix = alias.removesuffix('*')
            if ref == alias or ('*' in alias and ref.startswith(prefix)):
                base = UI / targets[0].replace('*', ref[len(prefix):])
                break
        else:
            if not ref.startswith('.'):
                continue  # Third-party dependencies are covered by lockfiles.
        if '*' in str(base):
            yield from (Path(p).resolve() for p in glob.glob(str(base), recursive=True))
            continue
        candidates = [base] + [Path(str(base) + ext) for ext in ('.ts', '.tsx', '.js', '.mjs')]
        candidates += [base / ('index' + ext) for ext in ('.ts', '.tsx', '.js')]
        resolved = next((p.resolve() for p in candidates if p.is_file()), None)
        if resolved is None:
            raise AssertionError(f'Unresolved local import {ref} in {source}')
        yield resolved


class DerivedInputs(unittest.TestCase):
    # test-category: pure-logic
    def test_ds_entrypoint_import_closure_selects_ds(self):
        workflow = (ROOT / '.github/workflows/ds-site.yml').read_text()
        package = json.loads((UI / 'package.json').read_text())
        configs = set(re.findall(r'--config (\S+)', ' '.join(package['scripts'].values())))
        pending = [UI / config for config in configs]
        pending += [UI / 'ds-site/index.html']
        pending += [ROOT / ref for ref in re.findall(r'\bbun run (tests/\S+\.ts)', workflow)]
        reached = set()
        while pending:
            source = pending.pop()
            if source in reached:
                continue
            reached.add(source)
            if source.suffix in ('.ts', '.tsx', '.js', '.mjs', '.html'):
                pending.extend(local_imports(source))
        self.assertTrue(any('butler-i18n' in str(p) for p in reached))
        self.assertIn(ROOT / 'tests/support/smoke-browser-args.ts', reached)
        for source in reached:
            path = source.relative_to(ROOT).as_posix()
            with self.subTest(path=path):
                self.assertIn('ds', changes.categories(path))
        print(f'DS import closure: {len(reached)} repository inputs')

    # test-category: pure-logic
    def test_rust_external_includes_and_build_reads_select_archives(self):
        rust = ROOT / ci_rust_inputs.RUST
        external = set()
        for source in rust.rglob('*.rs'):
            text = source.read_text()
            # Resolve literals independently of the selector's include matcher.
            consumed = text if source.name == 'build.rs' else '\n'.join(
                re.findall(r'\binclude(?:_str|_bytes)?!\s*\(([^)]*)', text))
            values = re.findall(r'"([^"\n]+)"', consumed)
            for value in values:
                value = value.removeprefix('cargo:rerun-if-changed=')
                if not value.startswith(('../', 'packages/')):
                    continue
                base = ROOT if value.startswith('packages/') else source.parent
                path = (base / value).resolve()
                if not path.is_relative_to(ROOT) or path.is_relative_to(rust):
                    continue
                if source.name != 'build.rs' and not value.startswith('../'):
                    continue
                if path.is_file():
                    external.add(path)
                elif path.is_dir():
                    external.update(p for p in path.rglob('*') if p.is_file() and 'node_modules' not in p.parts)
        self.assertTrue(any(p.suffix == '.mjs' for p in external))
        self.assertTrue(any(p.name == 'wallpaper.json' for p in external))
        for source in external:
            path = source.relative_to(ROOT).as_posix()
            with self.subTest(path=path):
                groups = changes.categories(path)
                self.assertIn('rust', groups)
                outputs = {g: str(g in groups).lower() for g in changes.GROUPS}
                jobs = changes.rust_jobs(dict(outputs, tier='smoke'), 'pull_request')
                for platform in ('linux', 'macos', 'linux-arm64'):
                    self.assertTrue(jobs[platform + '-archive'])
        print(f'Rust external inputs: {len(external)} files')

    # test-category: pure-logic
    def test_external_discovery_is_general_and_preserves_deleted_inputs(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            crate = root / ci_rust_inputs.RUST / 'crates/example'
            (crate / 'src').mkdir(parents=True)
            (crate / 'src/lib.rs').write_text('include_bytes!("../../../../../../assets/data.bin");')
            (crate / 'build.rs').write_text('const INPUT: &str = "../../../../../generated/catalog";')
            for path in ('assets/data.bin', 'generated/catalog/new.json'):
                self.assertTrue(ci_rust_inputs.consumes(path, root), path)
            self.assertFalse(ci_rust_inputs.consumes('assets/unrelated.bin', root))
