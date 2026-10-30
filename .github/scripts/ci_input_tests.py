"""Dependency-derived selector regressions, run by test-ci-changes.py."""
import glob
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import unittest
from unittest.mock import patch

import ci_policy
import ci_rust_inputs

ROOT = Path(__file__).resolve().parents[2]
UI = ROOT / 'packages/butler-app/client/ui'
SPEC = importlib.util.spec_from_file_location('input_changes', ROOT / '.github/scripts/ci-changes.py')
changes = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(changes)


def pr_jobs(paths, workflow='rust-quality.yml'):
    with tempfile.TemporaryDirectory() as temporary:
        env = dict(GITHUB_EVENT_NAME='pull_request', GITHUB_REF='refs/pull/1/merge',
                   GITHUB_REPOSITORY='owner/repo', GITHUB_RUN_ID='2',
                   GITHUB_OUTPUT=str(Path(temporary) / 'output'),
                   GITHUB_STEP_SUMMARY=str(Path(temporary) / 'summary'))
        with patch.dict(os.environ, env), patch.object(changes, 'command', return_value='head'), \
             patch.object(changes, 'changed', return_value=paths), \
             patch.object(changes, 'previous', return_value=iter([])), \
             patch.object(changes, 'hashes', return_value=dict.fromkeys(changes.GROUPS, 'hash')):
            changes.select({'pull_request': {'number': 1, 'base': {'sha': 'base'}}}, workflow)
        output = dict(line.split('=', 1) for line in Path(env['GITHUB_OUTPUT']).read_text().splitlines())
    return output, json.loads(output['jobs'])


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


def independent_includes(source):
    text = source.read_text()
    string = r'"(?:\\.|[^"\\])*"|r(?P<marks>\#*)".*?"(?P=marks)'
    for match in re.finditer(r'\binclude(?:_str|_bytes)?!\s*\(', text):
        level = 1
        end = match.end()
        while level and end < len(text):
            quoted = re.match(string, text[end:], re.DOTALL)
            if quoted:
                end += quoted.end()
                continue
            level += (text[end] == '(') - (text[end] == ')')
            end += 1
        if level:
            raise AssertionError(f'Unbalanced include in {source}')
        argument = text[match.end():end - 1].strip().removesuffix(',').strip()
        if re.search(r'env!\s*\(\s*"OUT_DIR"\s*\)', argument):
            continue
        literals = list(re.finditer(string, argument, re.DOTALL))
        remainder = re.sub(string, 'STRING', argument, flags=re.DOTALL)
        values = [m.group()[m.group().index('"') + 1:m.group().rindex('"')]
                  for m in literals]
        if remainder == 'STRING':
            yield source.parent / values[0]
        elif re.fullmatch(r'concat!\s*\(\s*env!\s*\(\s*STRING\s*\)'
                          r'\s*(?:,\s*STRING\s*)+,?\s*\)', remainder) and values[0] == 'CARGO_MANIFEST_DIR':
            crate = next(p for p in source.parents if (p / 'Cargo.toml').is_file())
            yield Path(str(crate) + ''.join(values[1:]))
        else:
            raise AssertionError(f'Unsupported include argument in {source}: {argument}')


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
    def test_installed_windows_browser_imports_select_and_invalidate_release(self):
        pending = [ROOT / 'tests/smoke/composer-permission-agent-smoke.ts']
        reached = set()
        while pending:
            source = pending.pop()
            if source in reached:
                continue
            reached.add(source)
            pending.extend(local_imports(source))
        groups = changes.job_groups('windows-preview-smoke.yml', integration=True)['release']
        for source in reached:
            path = source.relative_to(ROOT).as_posix()
            with self.subTest(path=path):
                categories = changes.categories(path)
                self.assertIn('package', categories)
                self.assertTrue(set(groups) & categories)
                self.assertTrue(changes.windows_native(path))
                outputs = {g: str(g in categories).lower() for g in changes.GROUPS}
                jobs = changes.windows_preview_jobs(dict(outputs, windows='true', tier='integration'), 'push')
                self.assertTrue(jobs['release'])

    # test-category: pure-logic
    def test_rust_external_includes_and_build_reads_select_archives(self):
        rust = ROOT / ci_rust_inputs.RUST
        external = set()
        for source in rust.rglob('*.rs'):
            text = source.read_text()
            paths = list(independent_includes(source))
            if source.name == 'build.rs':
                for value in re.findall(r'"([^"\n]+)"', text):
                    value = value.removeprefix('cargo:rerun-if-changed=')
                    if value.startswith(('../', 'packages/')):
                        base = ROOT if value.startswith('packages/') else source.parent
                        paths.append(base / value)
            for path in paths:
                path = path.resolve()
                if not path.is_relative_to(ROOT) or path.is_relative_to(rust):
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
                self.assertTrue(jobs['linux-archive'])
                self.assertFalse(jobs['macos-archive'])
                self.assertFalse(jobs['linux-arm64-archive'])
                main_jobs = changes.rust_jobs(dict(outputs, tier='smoke'), 'push')
                for platform in ('linux', 'macos', 'linux-arm64'):
                    self.assertTrue(main_jobs[platform + '-archive'])
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


    # test-category: pure-logic
    def test_nested_include_arguments_resolve_or_fail(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            crate = root / ci_rust_inputs.RUST / 'crates/example'
            (crate / 'src/nested').mkdir(parents=True)
            (root / ci_rust_inputs.RUST / 'Cargo.toml').touch()
            (crate / 'Cargo.toml').touch()
            source = crate / 'src/nested/lib.rs'
            for macro in ('include', 'include_str', 'include_bytes'):
                with self.subTest(macro=macro):
                    source.write_text(f'{macro}!(concat!(env!("CARGO_MANIFEST_DIR"), '
                                      '"/../../../../../assets/", "outside(1).mjs",));\n'
                                      'include!(concat!(env!("OUT_DIR"), "/generated.rs"));')
                    ci_rust_inputs.external_inputs.cache_clear()
                    self.assertEqual(ci_rust_inputs.external_inputs(str(root)),
                                     frozenset({'assets/outside(1).mjs'}))
                    self.assertEqual([p.resolve() for p in independent_includes(source)],
                                     [root / 'assets/outside(1).mjs'])
            for argument in ('PATH', 'concat!(env!("CARGO_MANIFEST_DIR"), unknown!())',
                             'concat!(env!("OTHER_DIR"), "/x.mjs")'):
                with self.subTest(argument=argument):
                    source.write_text(f'include_str!({argument});')
                    ci_rust_inputs.external_inputs.cache_clear()
                    with self.assertRaisesRegex(ValueError, 'Unsupported include argument.*lib.rs'):
                        ci_rust_inputs.external_inputs(str(root))
                    with self.assertRaisesRegex(AssertionError, 'Unsupported include argument'):
                        list(independent_includes(source))


    # test-category: pure-logic
    def test_signing_selects_own_inputs_through_workflow_jobs(self):
        workflow = 'rust-quality.yml'
        source = (ROOT / '.github/workflows' / workflow).read_text()
        for path, signing in {
            'deploy/macos/sign-and-notarize.sh': True,
            'packages/butler-app/scripts/release/package-app-release.ts': True,
            'packages/butler-app/client/electron/entitlements.mac.plist': True,
            'packages/butler-agent/rust/scripts/package-standalone-agent.py': True,
            'VERSION': True, 'package.json': True, 'bun.lock': True, 'bun.lockb': True,
            'packages/butler-agent/rust/crates/butler-core/src/lib.rs': False,
            'deploy/linux-app-smoke.sh': False, 'deploy/install.sh': False,
            'README.md': False,
        }.items():
            with self.subTest(path=path):
                output, jobs = pr_jobs([path], workflow)
                self.assertEqual(output['signing'], str(signing).lower())
                if path in ('package.json', 'bun.lock', 'bun.lockb'):
                    for group in ('package', 'install', 'linux-package'):
                        self.assertEqual(output[group], 'false')
                self.assertEqual(jobs['shellcheck'], output['package'] == 'true' or signing)
                self.assertFalse(jobs['selftest'])
        for name in ('shellcheck', 'selftest'):
            self.assertEqual(changes.job_groups(workflow)[name], ['package', 'signing'])
            block = re.split(r'\n  [a-z]', source.split(f'  {name}:\n', 1)[1], maxsplit=1)[0]
            self.assertIn(f"fromJSON(needs.changes.outputs.jobs)['{name}']", block)

    # test-category: security
    def test_ci_policy_change_without_invariant_update_fails_on_the_pr(self):
        """#1728: a PR changed PR_FAST_JOBS, but the stale Gate expectation first failed on main."""
        for paths, selected in [
            (['.github/scripts/ci_policy.py', '.github/scripts/ci_input_tests.py'], True),  # 3f2328e17
            (['.github/workflows/rust-archive.yml'], True), (['.github/workflows/macos-selftest.yml'], True),
            (['.github/actions/e2e-stub/action.yml'], True), (['.github/scripts/test-ci-invariants.py'], True),
            (['packages/butler-agent/rust/scripts/release-standalone-agent.py'], True),
            (['packages/butler-app/client/ui/src/main.tsx'], False), (['README.md'], False),
        ]:
            with self.subTest(paths=paths):
                output, jobs = pr_jobs(paths)
                self.assertEqual(output['workflows'], str(selected).lower())
                self.assertEqual(jobs['ci-invariants'], selected)
        workflow = (ROOT / '.github/workflows/rust-quality.yml').read_text()
        block = workflow.split('  ci-invariants:\n', 1)[1].split('\n\n', 1)[0]
        self.assertIn("fromJSON(needs.changes.outputs.jobs)['ci-invariants']", block)
        self.assertIn('test-ci-invariants.py --policy', block)
        self.assertNotIn('continue-on-error', block)
        self.assertNotIn('github.event_name', block)
        self.assertIn('ci-invariants', re.search(r'^  gate:\n(?:.*\n)*?    needs: \[(.+)\]', workflow, re.M)[1].split(', '))
        self.assertEqual(changes.job_groups('rust-quality.yml')['ci-invariants'], ['workflows'])
        spec = importlib.util.spec_from_file_location('pr_invariants', ROOT / '.github/scripts/test-ci-invariants.py')
        invariants = importlib.util.module_from_spec(spec)
        with patch.object(sys, 'argv', ['test-ci-invariants.py', '--policy']):
            spec.loader.exec_module(invariants)
        self.assertIn('Gate', invariants.policy_classes())
        self.assertNotIn('Coverage', invariants.policy_classes())

        def gate(fast_jobs):
            result = unittest.TestResult()
            with patch.object(ci_policy, 'PR_FAST_JOBS', fast_jobs):
                invariants.Gate('test_every_selected_job_must_succeed').run(result)
            return result
        # The unchanged policy passes in the ci-invariants job itself; any PR job
        # change without its expectation fails on the PR, before main.
        for job in ('shellcheck', 'selftest'):  # Remove (revert #1728) or add a PR job.
            with self.subTest(job=job):
                result = gate(ci_policy.PR_FAST_JOBS ^ {job})
                self.assertEqual(len(result.failures), 1)
                self.assertIn(repr(job), result.failures[0][1])
