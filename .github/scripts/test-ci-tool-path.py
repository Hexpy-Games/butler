#!/usr/bin/env python3
"""Tool-call path selection stays derived from the code it guards."""
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))
import ci_tool_path as tool_path

SPEC = importlib.util.spec_from_file_location('tool_changes', Path(__file__).with_name('ci-changes.py'))
changes = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(changes)
WORKFLOWS = ROOT / '.github/workflows'

CRATES = ROOT / tool_path.RUST / 'crates'
BOUNDARY = re.compile(r'\b(ModelRoundToolCall|CapabilityInvocation)\b')
USE = re.compile(r'^\s*(pub(\([^)]*\))?\s+)?use\s[^;]*;', re.M | re.S)
EMBED = re.compile(r'include_(?:str|bytes)!\(\s*"([^"]*capabilities/catalog/[^"]*)"')
# Production modules that only observe calls after dispatch: presentation,
# journaling and Work closeout. Each must still name the boundary types.
CONSUMERS = {
    'butler-agent/src/host/guided/activity.rs': 'activity titles',
    'butler-agent/src/host/guided/activity/content.rs': 'activity titles',
    'butler-agent/src/host/guided/journal.rs': 'call journaling',
    'butler-agent/src/host/guided/work.rs': 'Work closeout',
}
# The incident (#1363) and its fix (#1383) changed these production files.
INCIDENT = (
    'butler-agent/src/host/guided/tools/discovery/invoke.rs',
    'butler-models/src/models/provider/result.rs',
    'butler-models/src/models/provider/result/call.rs',
    'butler-models/src/models/provider/result/local.rs',
    'butler-models/src/models/provider/result/local/arguments.rs',
    'butler-runtime/src/capabilities/catalog.rs',
    'butler-runtime/src/capabilities/catalog/catalog.json',
    'butler-runtime/src/capabilities/catalog/validation.rs',
    'butler-turn/src/btcc/agent_loop/browser_context.rs',
    'butler-turn/src/btcc/agent_loop/tool_batch.rs',
    'butler-turn/src/btcc/tool_arguments.rs',
    'butler-turn/src/btcc/tool_arguments/direct.rs',
    'butler-turn/src/btcc/tool_arguments/example.rs',
    'butler-turn/src/btcc/tool_arguments/normalize.rs',
    'butler-turn/src/btcc/tool_arguments/validate.rs',
)


def crate_path(path):
    return f'{tool_path.RUST}/crates/{path}'


def production_sources():
    tracked = subprocess.check_output(['git', 'ls-files', '-z', f'{tool_path.RUST}/crates'],
                                      cwd=ROOT).decode().split('\0')
    for path in tracked:
        relative = path.removeprefix(f'{tool_path.RUST}/crates/')
        crate, _, rest = relative.partition('/')
        name = Path(rest).name
        if (not path.endswith('.rs') or not rest.startswith('src/')
                or crate in ('butler-e2e', 'butler-test-support') or '/tests/' in rest
                or name in ('tests.rs', 'testing.rs') or name.startswith('test_')
                or name.endswith('_tests.rs')):
            continue
        yield relative, (ROOT / path).read_text(encoding='utf-8')


class Boundary(unittest.TestCase):
    # test-category: pure-logic
    def test_roots_are_declared_modules(self):
        for root in tool_path.ROOTS:
            with self.subTest(root=root):
                crate, *modules = root.split('::')
                self.assertTrue((ROOT / (tool_path.module_base(root) + '.rs')).is_file())
                parent = CRATES / crate / 'src' / ('/'.join(modules[:-1]) + '.rs'
                                                   if len(modules) > 1 else 'lib.rs')
                declared = re.search(rf'^\s*(pub(\([^)]*\))?\s+)?mod {modules[-1]};',
                                     parent.read_text(encoding='utf-8'), re.M)
                self.assertTrue(declared, f'{parent} does not declare {modules[-1]}')

    # test-category: pure-logic
    def test_every_tool_call_handler_is_selected(self):
        handlers = {path for path, source in production_sources()
                    if BOUNDARY.search(USE.sub('', source))}
        self.assertGreater(len(handlers), 40)
        outside = sorted(handlers - set(CONSUMERS)
                         - {path for path in handlers if tool_path.selected(crate_path(path))})
        self.assertEqual(outside, [], 'add the owning module to ci_tool_path.ROOTS')
        self.assertLessEqual(set(CONSUMERS), handlers, 'remove stale consumer entries')

    # test-category: pure-logic
    def test_catalog_and_its_consumers_are_selected(self):
        catalog = tool_path.module_base('butler-runtime::capabilities') + '/catalog/catalog.json'
        source = (ROOT / catalog).read_text(encoding='utf-8')
        references = set(re.findall(r'"\$ref":\s*"([^"#][^"]*)"', source))
        self.assertTrue(references)
        for path in [catalog] + [str(Path(catalog).parent / name) for name in references]:
            self.assertTrue((ROOT / path).is_file(), path)
            self.assertTrue(tool_path.selected(path), path)
        embedders = [path for path, text in production_sources() if EMBED.search(text)]
        self.assertTrue(embedders)
        for path in embedders:
            self.assertTrue(tool_path.selected(crate_path(path)), path)

    # test-category: pure-logic
    def test_e2e_modules_exist(self):
        main = (CRATES / 'butler-e2e/tests/e2e/main.rs').read_text(encoding='utf-8')
        for module in tool_path.E2E:
            self.assertRegex(main, rf'(?m)^mod {module};$')
        self.assertEqual(tool_path.filterset(), 'binary(=e2e) and test(/^(' + '|'.join(tool_path.E2E) + ')::/)')


class Selection(unittest.TestCase):
    # test-category: pure-logic
    def test_schema_dispatch_and_handler_changes_select(self):
        for path in INCIDENT + (
                'butler-runtime/src/capabilities/catalog/answer-blocks.schema.json',
                'butler-runtime/src/capabilities/read_file.rs',
                'butler-core/src/tool_catalog.rs',
                'butler-agent/src/host/guided/tools/dispatch.rs',
                'butler-agent/src/host/guided/tools/memory_write.rs',
                'butler-agent/src/host/guided/tools/question.rs',
                'butler-agent/src/host/guided/tools/browser/act.rs'):
            with self.subTest(path=path):
                self.assertTrue(tool_path.selected(crate_path(path)))
        self.assertTrue(tool_path.selected('.github/scripts/ci_tool_path.py'))

    # test-category: pure-logic
    def test_unrelated_changes_do_not_select(self):
        for path in (crate_path('butler-memory/src/lib.rs'),
                     crate_path('butler-gateway/src/lib.rs'),
                     crate_path('butler-turn/src/btcc/tool_arguments_old.rs'),
                     crate_path('butler-agent/src/host/guided/toolsets.rs'),
                     crate_path('butler-agent/src/host/guided/activity.rs'),
                     crate_path('butler-e2e/tests/e2e/tools.rs'),
                     f'{tool_path.RUST}/Cargo.lock',
                     'packages/butler-app/client/ui/src/app.tsx',
                     'tests/smoke/browser-paint-electron.ts',
                     '.github/scripts/ci-changes.py', '.github/workflows/rust-archive.yml',
                     'README.md', f'{tool_path.RUST}/docs/tools.md'):
            with self.subTest(path=path):
                self.assertFalse(tool_path.selected(path))


    # test-category: pure-logic
    def test_only_pull_requests_touching_the_path_run_the_set(self):
        pr = dict(number=12, head=dict(ref='fix/example', sha='head', repo=dict(full_name='o/r')),
                  base=dict(ref='main', sha='base', repo=dict(full_name='o/r')))
        handler = crate_path('butler-agent/src/host/guided/tools/question.rs')
        cases = [('pull_request', [handler, 'README.md'], 'true'),
                 ('pull_request', [crate_path('butler-memory/src/lib.rs')], 'false'),
                 ('pull_request', ['packages/butler-app/client/ui/src/app.tsx'], 'false'),
                 ('pull_request', ['README.md'], 'false'),
                 ('push', [handler], 'false')]
        for event, paths, expected in cases:
            with self.subTest(event=event, paths=paths), tempfile.TemporaryDirectory() as directory:
                env = dict(GITHUB_EVENT_NAME=event, GITHUB_REF='refs/pull/12/merge',
                           GITHUB_REPOSITORY='o/r', GITHUB_RUN_ID='2', GITHUB_SHA='head',
                           GITHUB_OUTPUT=directory + '/out', GITHUB_STEP_SUMMARY=directory + '/summary')
                with patch.dict(os.environ, env), patch.object(changes, 'command', return_value='tree'), \
                     patch.object(changes, 'changed', return_value=paths), \
                     patch.object(changes, 'main_base', return_value='base'), \
                     patch.object(changes, 'hashes', return_value=dict.fromkeys(changes.GROUPS, 'hash')), \
                     patch.object(changes, 'previous', return_value=[]):
                    changes.select({'pull_request': pr} if event == 'pull_request' else {'before': 'base'},
                                   'rust-quality.yml')
                outputs = dict(line.split('=', 1) for line in Path(env['GITHUB_OUTPUT']).read_text().splitlines())
                self.assertEqual(outputs['tool-e2e'], expected)


class Wiring(unittest.TestCase):
    # test-category: format-pin
    def test_pr_archive_runs_the_selected_set_in_place(self):
        quality = (WORKFLOWS / 'rust-quality.yml').read_text()
        linux = quality.split('\n  linux-archive:\n')[1].split('\n  linux-perf-archive:')[0]
        self.assertIn("tool-e2e: ${{ needs.changes.outputs.tool-e2e == 'true' }}", linux)
        self.assertEqual(quality.count('tool-e2e:'), 1)
        for path in (WORKFLOWS / 'ci-changes.yml', ROOT / '.github/actions/changes/action.yml'):
            self.assertIn('outputs.tool-e2e }}', path.read_text())
        archive = (WORKFLOWS / 'rust-archive.yml').read_text()
        steps = {step.splitlines()[0]: step for step in archive.split('      - name: ')[1:]}
        self.assertIn('if: inputs.fixtures || inputs.tool-e2e', steps['Build E2E fixture Agent'])
        self.assertIn('ci_tool_path.py filterset', steps['Select the tool-call path E2E set'])
        run = steps['Run the tool-call path stub E2E set']
        for text in ('uses: ./.github/actions/e2e-stub', 'if: inputs.tool-e2e',
                     'agent-binary: ${{ runner.temp }}/rust-archive/butler-agent',
                     'filterset: ${{ steps.tool-e2e.outputs.filterset }}', 'workspace: "true"'):
            self.assertIn(text, run)
        failures = steps['Upload tool-call path E2E failures']
        self.assertIn('if: failure() && inputs.tool-e2e', failures)
        self.assertIn('${{ runner.temp }}/butler-e2e/failures', failures)
        build = steps['Build the complete workspace once']
        version = re.search(r"BUILD_VERSION_REF: \$\{\{ github.event_name == 'pull_request' && '([^']+)'", build)[1]
        self.assertIn(f'build-version-ref: {version}', run)


if __name__ == '__main__':
    unittest.main()
