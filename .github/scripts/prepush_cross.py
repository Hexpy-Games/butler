"""Probe cross C toolchains before local Clippy, without installing anything."""
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile


def target_env(name, target):
    # cc-rs lookup order: exact triple, underscored triple, TARGET_*, plain *.
    for key in (f'{name}_{target}', f'{name}_{target.replace("-", "_")}',
                f'TARGET_{name}', name):
        if os.environ.get(key):
            return os.environ[key]
    return ''


def linker_env(target):
    return os.environ.get('CARGO_TARGET_' + target.replace('-', '_').upper() + '_LINKER', '')


def compiler_command(target):
    configured = target_env('CC', target)
    if configured:
        command = shlex.split(configured)
    elif target.endswith('-msvc'):
        command = [next((c for c in ('cl', 'clang-cl') if shutil.which(c)), 'clang-cl')]
    elif linker_env(target).endswith(('-gcc', '-clang')):
        command = [linker_env(target)]
    else:
        prefix = os.environ.get('CROSS_COMPILE', target.replace('-unknown', '') + '-').rstrip('-')
        command = [next((c for c in (target + '-gcc', prefix + '-gcc', 'clang')
                         if shutil.which(c)), prefix + '-gcc')]
    # Like cc-rs, clang needs an explicit target, including when set via CC.
    if any('clang' in Path(arg).name for arg in command):
        command.append('--target=' + target)
    for key in ('CFLAGS', 'TARGET_CFLAGS', f'CFLAGS_{target.replace("-", "_")}',
                f'CFLAGS_{target}'):
        command += shlex.split(os.environ.get(key, ''))
    return command


def probe_c_toolchain(target, cwd):
    command = compiler_command(target)
    if not shutil.which(command[0]):
        return 'C compiler unavailable: ' + command[0]
    linker = linker_env(target)
    if linker and not shutil.which(linker):
        return 'linker unavailable: ' + linker
    with tempfile.TemporaryDirectory(prefix='prepush-cross-') as directory:
        source = Path(directory) / 'probe.c'
        source.write_text('#include <stdint.h>\n#include <stdlib.h>\n#include <string.h>\n'
                          'int main(void) { return 0; }\n')
        obj = Path(directory) / 'probe.o'
        msvc = target.endswith('-msvc')
        args = ([str(source), '/nologo', '/c', '/Fo' + str(obj)] if msvc else
                [str(source), '-o', str(obj)])
        result = subprocess.run(command + args, cwd=cwd, text=True, capture_output=True)
        if not result.returncode and msvc:
            driver = linker or next((c for c in ('lld-link', 'link.exe') if shutil.which(c)), '')
            if not driver:
                return 'MSVC linker unavailable: lld-link or link.exe'
            result = subprocess.run([driver, str(obj), '/entry:main', '/subsystem:console',
                                     '/nodefaultlib', '/out:' + str(obj.with_suffix('.exe'))],
                                    cwd=cwd, text=True, capture_output=True)
        if result.returncode:
            diagnostics = ' '.join((result.stderr or result.stdout).split())
            return 'target C compiler/headers/linker probe failed: ' + diagnostics
    return ''


def prerequisites(target, installed, cwd):
    missing = []
    if target not in installed:
        missing.append(f'Rust std missing (rustup target add {target})')
    reason = probe_c_toolchain(target, cwd)
    if reason:
        missing.append(reason)
    return missing


def enable_hint(target):
    cc = 'CC_' + target.replace('-', '_')
    linker = 'CARGO_TARGET_' + target.replace('-', '_').upper() + '_LINKER'
    if target.endswith('-msvc'):
        setup = 'xwin SDK headers/libraries with clang-cl and lld-link (https://github.com/Jake-Shadle/xwin)'
    else:
        setup = 'a target GCC/sysroot or cargo-zigbuild/zig C wrapper (https://github.com/rust-cross/cargo-zigbuild)'
    return f'enable with {setup}; configure {cc}, CFLAGS_{target.replace("-", "_")} and {linker}'
