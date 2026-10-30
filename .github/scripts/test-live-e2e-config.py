#!/usr/bin/env python3
"""Live E2E jobs take their provider and model from `live-e2e` variables."""
import json
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS = ROOT / '.github/workflows'
CATALOG = ROOT / 'packages/butler-agent/rust/crates/butler-models/src/models/catalog/static-catalog.json'
JOB = re.compile(r'^  ([\w-]+):\s*$', re.M)
LITERAL = re.compile(r'BUTLER_E2E_(PROVIDER|MODEL|MODEL_MATRIX)\s*[:=]\s*[\'"]?(?!\$\{\{)[\w.@/-]')


def live_jobs():
    for path in sorted(WORKFLOWS.glob('*.yml')):
        text = path.read_text(encoding='utf-8')
        if 'jobs:' not in text:
            continue
        body = text.split('\njobs:\n', 1)[1]
        starts = [match.start() for match in JOB.finditer(body)] + [len(body)]
        for start, end in zip(starts, starts[1:]):
            job = body[start:end]
            if re.search(r'^    environment: live-e2e\s*$', job, re.M):
                yield f'{path.name}:{JOB.match(job).group(1)}', job


def catalog_models():
    catalog = json.loads(CATALOG.read_text(encoding='utf-8'))
    return {model['model_id'] for model in catalog['models']} | {
        model['model_ref'] for model in catalog['models']}


class LiveE2EConfig(unittest.TestCase):
    # test-category: format-pin
    def test_live_jobs_read_the_environment_variables(self):
        jobs = dict(live_jobs())
        self.assertGreaterEqual(len(jobs), 2, 'live-e2e jobs not found')
        for name, job in jobs.items():
            with self.subTest(job=name):
                for reference in ('vars.BUTLER_E2E_LIVE_PROVIDER', 'vars.BUTLER_E2E_LIVE_MODEL',
                                  'secrets.BUTLER_E2E_API_KEY'):
                    self.assertTrue('${{ %s }}' % reference in job, f'{reference} is not read')
                for variable in ('BUTLER_E2E_LIVE_PROVIDER', 'BUTLER_E2E_LIVE_MODEL'):
                    self.assertRegex(job, rf'Set the live-e2e variable {variable}\b')

    # test-category: format-pin
    def test_live_jobs_name_no_provider_or_model(self):
        models = catalog_models()
        for name, job in live_jobs():
            with self.subTest(job=name):
                self.assertIsNone(LITERAL.search(job), 'live selection is set to a literal')
                named = sorted(model for model in models
                               if re.search(rf'(?<![\w.-]){re.escape(model)}(?![\w.-])', job))
                self.assertEqual(named, [], 'hard-coded model')

    # test-category: format-pin
    def test_callers_pass_the_environment_secret(self):
        # A called workflow reads an environment secret only when its caller passes it.
        called = {name.split(':')[0] for name, _ in live_jobs()}
        callers = 0
        for path in sorted(WORKFLOWS.glob('*.yml')):
            body = path.read_text(encoding='utf-8').split('\njobs:\n', 1)[-1]
            starts = [match.start() for match in JOB.finditer(body)] + [len(body)]
            for start, end in zip(starts, starts[1:]):
                job = body[start:end]
                uses = re.search(r'^    uses: \./\.github/workflows/([\w.-]+)\s*$', job, re.M)
                if not uses or uses.group(1) not in called:
                    continue
                callers += 1
                with self.subTest(caller=f'{path.name}:{JOB.match(job).group(1)}'):
                    self.assertRegex(job, re.compile(r'^    secrets:( inherit$|\n(      .*\n)*      BUTLER_E2E_API_KEY: '
                                                     r'\$\{\{ secrets\.BUTLER_E2E_API_KEY \}\}$)', re.M))
        self.assertGreaterEqual(callers, 1, 'live-e2e workflow callers not found')


if __name__ == '__main__':
    unittest.main()
