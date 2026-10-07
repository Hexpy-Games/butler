"""Guard straight-line PS 5.1 native calls in owner steps and scripts.

GitHub starts PowerShell steps under Stop. Redirection alone does not prevent
NativeCommandError in 5.1; require Continue at the call, then an exit-code check.
This is deliberately limited to literal native commands and executable calls.
"""
import re

NATIVE = re.compile(
    r'^\s*(?:\$[\w:]+\s*=\s*)?(?:'
    r'(?:&\s+)?(?:cargo|rustc|rustup|python[3]?|bun|node|npm(?:\.cmd)?|gh|oras|dumpbin|'
    r'cmd(?:\.exe)?|reg(?:\.exe)?|tar|zstd|powershell(?:\.exe)?)\s|'
    r'&\s+(?:[\"\'][^\n]*?\.(?:exe|cmd)[\"\']|\$(?:Executable|vswhere|env:ComSpec))\s)', re.I)
PREFERENCE = re.compile(r'^\s*\$ErrorActionPreference\s*=\s*[\"\'](Stop|Continue)[\"\']', re.I)


def statements(source):
    lines = source.splitlines()
    index = 0
    while index < len(lines):
        start = index
        while index + 1 < len(lines) and lines[index].rstrip().endswith(('`', '|')):
            index += 1
        yield start + 1, index + 1, '\n'.join(lines[start:index + 1])
        index += 1


def script_hazards(source):
    preference = 'stop'
    setting_indent = None
    findings = []
    for start, _, statement in statements(source):
        if statement.lstrip().startswith('#'):
            continue
        setting = PREFERENCE.search(statement)
        if setting:
            preference = setting[1].lower()
            setting_indent = len(statement) - len(statement.lstrip())
        if NATIVE.match(statement) and (preference != 'continue'
                or setting_indent != len(statement) - len(statement.lstrip())):
            findings.append((start, 'PS 5.1 native stderr under Stop (use scoped Continue and LASTEXITCODE)'))
    return findings


def hazards(source, powershell_default=False):
    """Audit each run separately; never carry preferences across GitHub steps."""
    if not re.search(r'^\s*(?:runs:|jobs:|runs-on:|steps:)', source, re.M):
        return script_hazards(source)
    findings = []
    steps = re.split(r'(?=^\s*- (?:name:|uses:|run:|shell:))', source, flags=re.M)
    offset = 0
    for step in steps:
        shell = re.search(r'^\s*(?:- )?shell:[ \t]*(.+)', step, re.M)
        powershell = ('powershell' in shell[1].lower()) if shell else powershell_default
        run = re.search(r'^([ \t]*)run:\s*([|>]\-?)(?:\s*\n)', step, re.M)
        if powershell and run:
            indent = len(run[1])
            body = []
            for line in step[run.end():].splitlines():
                if line.strip() and len(line) - len(line.lstrip()) <= indent:
                    break
                body.append(line)
            base = offset + step[:run.end()].count('\n')
            findings += [(base + line, kind) for line, kind in script_hazards('\n'.join(body))]
        # Single-line native steps have no chance to set the preference.
        single = re.search(r'^\s*(?:- )?run:[ \t]*(?![|> \t])([^\n]+)', step, re.M)
        if powershell and single and NATIVE.match(single[1]):
            findings.append((offset + step[:single.start(1)].count('\n') + 1,
                             'PS 5.1 native stderr under Stop (use scoped Continue and LASTEXITCODE)'))
        offset += step.count('\n')
    return findings
