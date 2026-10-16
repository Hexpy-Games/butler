"""Derive CI input consumers from workflow jobs, local actions and Python imports.

No YAML dependency: GitHub job keys have two-space indentation; references are
collected from complete job blocks, including folded expressions and run blocks.
"""
import ast
from collections import defaultdict
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[2]
REFERENCES = re.compile(r'\.?/?(\.github/(?:scripts/[\w.-]+|actions/[\w.-]+|workflows/[\w.-]+\.ya?ml))')


def jobs(source):
    body = source.split('\njobs:\n', 1)[1]
    return {match[1]: match[2] for match in re.finditer(
        r'^  ([\w-]+):[^\n]*\n(.*?)(?=^  [\w-]+:|\Z)', body, re.M | re.S)}


def references(source):
    paths = set()
    for name in REFERENCES.findall(source):
        path = ROOT / name
        if path.is_dir():
            path = next((path / file for file in ('action.yml', 'action.yaml')
                         if (path / file).is_file()), path)
        if path.is_file():
            paths.add(path)
    return paths


def python_imports(path):
    tree = ast.parse(path.read_text())
    result = set()
    for node in ast.walk(tree):
        names = []
        if isinstance(node, ast.Import):
            names = [alias.name for alias in node.names]
        elif isinstance(node, ast.ImportFrom) and node.module:
            names = [node.module]
        elif (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
              and node.func.attr == 'import_module' and node.args
              and isinstance(node.args[0], ast.Constant)):
            names = [node.args[0].value]
        elif isinstance(node, ast.Constant) and isinstance(node.value, str):
            # importlib loads hyphenated local modules using with_name()/paths.
            names = [node.value] if node.value.endswith('.py') else []
        for name in names:
            candidate = path.parent / (name if name.endswith('.py') else name + '.py')
            if candidate.is_file():
                result.add(candidate)
    return result


def dependencies(path):
    return python_imports(path) if path.suffix == '.py' else references(path.read_text())


def receipt_groups(source, blocks, groups):
    mapping = defaultdict(set)
    for raw in re.findall(r"^\s+groups: '([^']+)'", source, re.M):
        for group, names in json.loads(raw).items():
            for name in names:
                mapping[name].add(group)
    for name, block in blocks.items():
        # Only the job header's selection expression, never its steps' ifs.
        header = re.split(r'^    steps:', block, maxsplit=1, flags=re.M)[0]
        mapping[name].update(set(re.findall(r'needs\.changes\.outputs\.([\w-]+)', header)) & groups)
    return {name: inputs for name, inputs in mapping.items() if inputs}


def integration_groups(mapping, blocks):
    """Independently model integration reuse keys, including producer inputs."""
    result = {name: set(inputs) for name, inputs in mapping.items()}
    for inputs in result.values():
        if inputs & {'package', 'install', 'linux-package'}:
            inputs.update(('rust', 'ui'))
    for _ in range(len(result)):
        for name, inputs in result.items():
            needs = re.search(r'^    needs: (.+)$', blocks.get(name, ''), re.M)
            if needs:
                for dependency in re.findall(r'[\w-]+', needs[1]):
                    inputs.update(result.get(dependency, set()))
    return result


def consumer_groups(groups):
    """Return path -> groups whose jobs directly or transitively consume it."""
    expected = defaultdict(set)
    edges = defaultdict(set)
    workflows = sorted((ROOT / '.github/workflows').glob('*.y*ml'))
    actions = sorted((ROOT / '.github/actions').glob('*/action.y*ml'))
    scripts = sorted((ROOT / '.github/scripts').glob('*.py'))
    for path in actions + scripts:
        edges[path].update(dependencies(path))
    for path in workflows:
        source = path.read_text()
        blocks = jobs(source)
        smoke = receipt_groups(source, blocks, set(groups))
        integration = integration_groups(smoke, blocks)
        owned = set().union(*smoke.values(), *integration.values())
        infrastructure = {'workflows'} if owned or 'workflow_call:' not in source else set()
        expected[path].update(owned or infrastructure)
        for name, block in blocks.items():
            inputs = smoke.get(name, set()) | integration.get(name, set())
            # Infrastructure/lint jobs run independently of product selection.
            inputs = inputs or infrastructure
            for dependency in references(block):
                expected[dependency].update(inputs)
        if 'workflow_call:' in source and not owned:
            edges[path].update(references(source))
    pending = list(expected)
    while pending:
        path = pending.pop()
        for dependency in edges[path]:
            added = expected[path] - expected[dependency]
            if added:
                expected[dependency].update(added)
                pending.append(dependency)
    return {str(path.relative_to(ROOT)): inputs for path, inputs in expected.items()}
