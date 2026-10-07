"""Static safety boundary for jobs sharing the owner Windows host.

Walk local composite actions and literal script entry points. This deliberately
rejects absolute drive paths even for reads: installed tools use environment
variables, while all CI-owned writes belong to the workspace or runner temp.
"""
import ast
import importlib.util
import re
from pathlib import Path


_native_spec = importlib.util.spec_from_file_location(
    'windows_native_safety', Path(__file__).with_name('windows-native-safety.py'))
native_safety = importlib.util.module_from_spec(_native_spec)
_native_spec.loader.exec_module(native_safety)

ALLOWED_ACTIONS = re.compile(
    r'(?:actions/(?:checkout|upload-artifact|download-artifact|cache)@[^\s]+|'
    r'\./\.github/actions/[\w/-]+)\Z')

RULES = {
    'unavailable PowerShell 7 shell': r'^\s*(?:-\s*)?shell:\s*[\x22\x27]?pwsh\b',
    'PowerShell CI script blocked by execution policy': r'^\s*(?:-\s*)?shell:\s*[\x22\x27]?powershell[\x22\x27]?\s*$',
    'unsafe Windows ORAS setup action': r'\buses:\s*[\x22\x27]?oras-project/setup-oras@',
    'absolute drive path': r'(?<![\w])[A-Za-z]:[\\/]',
    'fixed absolute temp path': r'(?<![\w])/(?:tmp|var/tmp|Users|home)/',
    'fixed port': (r'(?:localhost|127\.0\.0\.1):[1-9]\d*|'
                   r'\b(?:[\w]*PORT|port)\s*[:=]\s*[\x22\x27]?[1-9]\d*|'
                   r'--(?:port|remote-debugging-port)[=\s]+[1-9]\d*|'
                   r'TcpListener[^\n]*,\s*[1-9]\d*|\bhttp\.server\s+[1-9]\d*'),
    'name-based process kill': (r'\btaskkill(?:\.exe)?\b[^\n]*\s/IM\b|'
                                r'\bStop-Process\b[^\n]*\s-Name\b|'
                                r'\bGet-Process\b[^\n]*\|[^\n]*\bStop-Process\b|'
                                r'\bStop-Process\b[^\n]*\bGet-Process\b[^\n]*-Name\b|'
                                r'\b(?:pkill|killall)\b'),
    'owner profile write path': (r'(?:\$env:USERPROFILE|%USERPROFILE%)[\\/]'
                                 r'(?!\.cargo\b|\.rustup\b)|'
                                 r'(?:\$env:LOCALAPPDATA|%LOCALAPPDATA%)[\\/]butler-app'),
    'owner installer or host configuration write': (
        r'\b(?:choco|winget|msiexec|setx)(?:\.exe)?\b|'
        r'\bSet-ItemProperty\b[^\n]*(?:HKLM|HKCU|HKEY_LOCAL_MACHINE|HKEY_CURRENT_USER)\b|'
        r'\b(?:rustup(?:\.exe)?\s+(?:toolchain\s+install|default|update)|rustup-init)\b|'
        r'\b(?:pip|pip3)(?:\.exe)?\s+install\b|\bpython\s+-m\s+pip\s+install\b|'
        r'\bSetEnvironmentVariable\b[^\n]*[\x22\x27](?:Machine|User)[\x22\x27]'),
    'non-job-scoped PATH modification': r'\bGITHUB_PATH\b',
    'machine mutation or installer smoke': (
        r'\b(?:winget|choco)\s+install\b|\bnpm(?:\.cmd)?\s+(?:i|install)\s+(-g|--global)\b|'
        r'\b(?:Register-ScheduledTask|New-Service|Set-Service)\b|'
        r'\breg(?:\.exe)?(?:\s+|[\x22\x27]\s*,\s*[\x22\x27])(?:add|delete|import)\b|'
        r'(?:released-install-smoke|installer-smoke|windows-startup-smoke|windows-task-xml-probe)\.(?:ts|ps1)')
}
SCRIPT = re.compile(r'(?:\$PSScriptRoot/|(?:\.\.?/)*)([\w./-]+\.(?:ps1|py|ts|mjs))\b')


def windows_test(node):
    if not isinstance(node, ast.Compare) or len(node.ops) != 1:
        return None
    expression = ast.unparse(node.left)
    value = node.comparators[0]
    expected = {'sys.platform': 'win32', 'os.name': 'nt', 'platform.system()': 'Windows'}
    if expression not in expected or not isinstance(value, ast.Constant) or value.value != expected[expression]:
        return None
    if isinstance(node.ops[0], ast.Eq):
        return True
    if isinstance(node.ops[0], ast.NotEq):
        return False
    return None


def symlink_hazards(source):
    """A symlink call must be unreachable on Windows, on the Unix branch only."""
    findings = []
    try:
        tree = ast.parse(source)
    except SyntaxError:
        tree = None  # PowerShell, shell and workflow snippets are checked below.
    if tree is not None:
        def walk(node, unix_only=False):
            if isinstance(node, ast.If) and windows_test(node.test) is not None:
                for statement in node.body:
                    walk(statement, unix_only or not windows_test(node.test))
                for statement in node.orelse:
                    walk(statement, unix_only or windows_test(node.test))
                return
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
                if node.func.attr in ('symlink', 'symlink_to') and not unix_only:
                    findings.append((node.lineno, 'symlink creation without Windows fallback'))
            for child in ast.iter_child_nodes(node):
                walk(child, unix_only)
        walk(tree)
    for number, line in enumerate(source.splitlines(), 1):
        if line.lstrip().startswith(('#', '//')):
            continue
        if (re.search(r'\bNew-Item\b[^\n]*-ItemType\s+["\']?SymbolicLink\b', line, re.I)
                or re.search(r'\bmklink\b', line, re.I) and not re.search(r'\s/J\b', line, re.I)
                or 'winsymlinks:nativestrict' in line):
            findings.append((number, 'privileged Windows symlink creation'))
    return findings


def python_sources(path, seen):
    """Follow local Python imports; imported modules get the link-privilege check."""
    if path.suffix != '.py':
        return
    tree = ast.parse(path.read_text())
    for node in ast.walk(tree):
        names = []
        if isinstance(node, ast.Import):
            names = [alias.name for alias in node.names]
        elif isinstance(node, ast.ImportFrom) and node.module:
            names = [node.module]
        for name in names:
            candidate = path.with_name(name.split('.')[0] + '.py').resolve()
            if candidate.is_file() and candidate not in seen:
                seen.add(candidate)
                yield candidate, candidate.read_text()
                yield from python_sources(candidate, seen)


def hazards(source):
    findings = []
    for number, line in enumerate(source.splitlines(), 1):
        if line.lstrip().startswith(('#', '//')):
            continue
        action = re.search(r"\buses:\s*[\"']?([^\s\"']+)", line)
        if action and not ALLOWED_ACTIONS.fullmatch(action[1]):
            findings.append((number, 'action not allowed on owner runner: ' + action[1]))
        for kind, pattern in RULES.items():
            if kind == 'non-job-scoped PATH modification' and re.search(
                    r'\|\s*Out-File -FilePath \$env:GITHUB_PATH -Encoding utf8 -Append\s*$', line, re.I):
                continue  # GitHub runner command file, never persistent host PATH.
            if kind == 'owner profile write path' and 'Get-ChildItem' in line and '\\Downloads' in line:
                continue  # Existing owner-profile observation is read-only.
            if re.search(pattern, line, re.I):
                findings.append((number, kind))
        if re.search(r'\bStop-Process\b', line, re.I) and not re.search(r'-Id\b', line, re.I):
            findings.append((number, 'process kill without explicit PID'))
    return findings + symlink_hazards(source)


def owner_steps(source, owner_input):
    """Exclude only a literal hosted-only input guard proven by the caller.

    Blank excluded lines to retain diagnostic line numbers. Unknown expressions
    remain reachable and must pass the owner safety checks.
    """
    if not owner_input:
        return source
    blocks = re.split(r'(?=^\s*- (?:uses:|name:|run:))', source, flags=re.M)
    guard = r"^\s*if:\s*(?:\$\{\{\s*)?inputs\.owner-runner != 'true'(?:\s*\}\})?\s*$"
    return ''.join('\n' * block.count('\n') if re.search(guard, block, re.M) else block
                   for block in blocks)


def local_sources(root, path, source, seen, owner_input=False):
    """Follow local actions and scripts without traversing dependencies or data."""
    source = owner_steps(source, owner_input)
    yield path, source
    references = re.findall(r'uses:\s*\./([^\s]+)', source)
    references += re.findall(r'\$\{\{ github.action_path \}\}/([\w/-]+\.ps1)', source)
    for line in source.splitlines():
        if line.lstrip().startswith(('#', '//', 'import ', 'from ')):
            continue
        if path.suffix not in ('.yml', '.yaml') and not re.search(
                r'\b(?:subprocess|spawn|run|command|Start-Process)\b|^\s*&|\$PSScriptRoot', line):
            continue
        references += SCRIPT.findall(line)
    for name in references:
        repository_path = re.search(r'(?:^|/)((?:\.github|deploy|packages|tests)/.*)', name)
        if repository_path:
            name = repository_path[1]
        candidate = root / name
        if candidate.is_dir():
            candidate /= 'action.yml'
        if not candidate.is_file() and name.endswith(('.ps1', '.py', '.ts', '.mjs')):
            candidate = path.parent / name
        if not candidate.is_file() and name.startswith('scripts/'):
            candidate = root / 'packages/butler-agent/rust' / name
        candidate = candidate.resolve()
        if not candidate.is_relative_to(root.resolve()) or not candidate.is_file() or candidate in seen:
            continue
        seen.add(candidate)
        step = re.search(r'uses:\s*\./' + re.escape(name) + r'[^\n]*\n'
                         r'(?:(?!\s*- (?:uses:|name:|run:)).*\n)*', source)
        bound_owner = step and re.search(r"owner-runner:\s*['\"]?true['\"]?\s*$", step[0], re.M)
        if step and not bound_owner:
            # This exact selector reaches butler-win only when runner != hosted.
            selector = "inputs.runner == 'hosted' && 'windows-latest'"
            runner = re.search(r'^\s*runs-on:\s*(.+)$', source, re.M)
            bound_owner = runner and selector in runner[1] and 'fromJSON(\'["self-hosted", "butler-win"]\')' in runner[1] and re.search(
                r"owner-runner:\s*\$\{\{ inputs\.runner != 'hosted' \}\}", step[0])
        yield from local_sources(root, candidate, candidate.read_text(), seen, bool(bound_owner))


def audit(root):
    findings, jobs = [], []
    for workflow in sorted((root / '.github/workflows').glob('*.y*ml')):
        source = workflow.read_text()
        for block in re.split(r'(?=^  [\w-]+:\s*\n)', source, flags=re.M):
            runner = re.search(r'^    runs-on:[ \t]*([^\n]*(?:\n      - [^\n]+)*)', block, re.M)
            owner_runner = runner and re.search(r'butler-win|self-hosted', runner[1], re.I)
            owner_matrix = runner and 'matrix.runner' in runner[1] and re.search(
                r'runner:\s*\[[^\n]*butler-win', block, re.I)
            if not (owner_runner or owner_matrix):
                continue
            job = block.split(':', 1)[0].strip()
            jobs.append(f'{workflow.name}/{job}')
            offset = source.index(block)
            # Workflow defaults also apply to owner jobs with no step shell.
            prefix = source.split('\njobs:', 1)[0]
            for line, hazard in hazards(prefix):
                if hazard in ('unavailable PowerShell 7 shell', 'PowerShell CI script blocked by execution policy'):
                    findings.append(f'{workflow.relative_to(root)}:{line}: {hazard}')
            imported = set()
            for path, text in local_sources(root, workflow, block, {workflow.resolve()}):
                for module, module_text in python_sources(path, imported):
                    for line, hazard in symlink_hazards(module_text):
                        findings.append(f'{module.relative_to(root)}:{line}: {hazard}')
                default_ps = bool(re.search(r'shell:\s*powershell\b', prefix + block))
                native = native_safety.hazards(text, default_ps) if path.suffix in ('.yml', '.yaml', '.ps1') else []
                for line, hazard in hazards(text) + native:
                    if path == workflow:
                        line += source[:offset].count('\n')
                    findings.append(f'{path.relative_to(root)}:{line}: {hazard}')
    return jobs, sorted(set(findings))
