"""Static safety boundary for jobs sharing the owner Windows host.

Walk local composite actions and literal script entry points. This deliberately
rejects absolute drive paths even for reads: installed tools use environment
variables, while all CI-owned writes belong to the workspace or runner temp.
"""
import re
from pathlib import Path


RULES = {
    'unavailable PowerShell 7 shell': r'^\s*(?:-\s*)?shell:\s*[\x22\x27]?pwsh\b',
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
    'machine mutation or installer smoke': (
        r'\b(?:winget|choco)\s+install\b|\bnpm(?:\.cmd)?\s+(?:i|install)\s+(-g|--global)\b|'
        r'\b(?:Register-ScheduledTask|New-Service|Set-Service)\b|'
        r'\breg(?:\.exe)?\s+(?:add|delete|import)\b|'
        r'(?:released-install-smoke|installer-smoke|windows-startup-smoke|windows-task-xml-probe)\.(?:ts|ps1)')
}
SCRIPT = re.compile(r'(?:\$PSScriptRoot/|(?:\.\.?/)*)([\w./-]+\.(?:ps1|py|ts|mjs))\b')


def hazards(source):
    findings = []
    for number, line in enumerate(source.splitlines(), 1):
        if line.lstrip().startswith(('#', '//')):
            continue
        for kind, pattern in RULES.items():
            if kind == 'owner profile write path' and 'Get-ChildItem' in line and '\\Downloads' in line:
                continue  # Existing owner-profile observation is read-only.
            if re.search(pattern, line, re.I):
                findings.append((number, kind))
        if re.search(r'\bStop-Process\b', line, re.I) and not re.search(r'-Id\b', line, re.I):
            findings.append((number, 'process kill without explicit PID'))
    return findings


def local_sources(root, path, source, seen):
    """Follow local actions and scripts without traversing dependencies or data."""
    yield path, source
    references = re.findall(r'uses:\s*\./([^\s]+)', source)
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
        yield from local_sources(root, candidate, candidate.read_text(), seen)


def audit(root):
    findings, jobs = [], []
    for workflow in sorted((root / '.github/workflows').glob('*.yml')):
        source = workflow.read_text()
        for block in re.split(r'(?=^  [\w-]+:\s*\n)', source, flags=re.M):
            runner = re.search(r'^    runs-on:[ \t]*([^\n]*(?:\n      - [^\n]+)*)', block, re.M)
            if not runner or not re.search(r'butler-win|self-hosted', runner[1], re.I):
                continue
            job = block.split(':', 1)[0].strip()
            jobs.append(f'{workflow.name}/{job}')
            offset = source.index(block)
            # Workflow defaults also apply to owner jobs with no step shell.
            prefix = source.split('\njobs:', 1)[0]
            for line, hazard in hazards(prefix):
                if hazard == 'unavailable PowerShell 7 shell':
                    findings.append(f'{workflow.relative_to(root)}:{line}: {hazard}')
            for path, text in local_sources(root, workflow, block, {workflow.resolve()}):
                for line, hazard in hazards(text):
                    if path == workflow:
                        line += source[:offset].count('\n')
                    findings.append(f'{path.relative_to(root)}:{line}: {hazard}')
    return jobs, sorted(set(findings))
