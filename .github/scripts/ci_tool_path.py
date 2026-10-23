#!/usr/bin/env python3
"""Select the stub E2E set for PRs that change the tool-call path."""
from pathlib import Path
import sys

RUST = 'packages/butler-agent/rust'
# Module trees (`<module>.rs` plus `<module>/**`) that define, enforce, dispatch
# and parse model tool calls. test-ci-tool-path.py derives the boundary from the
# code and fails when a tool-call module or catalog consumer lies outside them.
ROOTS = (
    'butler-core::tool_catalog',                 # catalog loading and $ref expansion
    'butler-core::tool_protocol',                # tool names and call stream protocol
    'butler-runtime::capabilities',              # catalog.json, schemas, file tool handlers
    'butler-models::models::provider::result',   # provider tool-call decoding
    'butler-turn::btcc::tool_arguments',         # schema normalization and enforcement
    'butler-turn::btcc::agent_loop',             # tool batches and their dispatch
    'butler-agent::host::guided::catalog',       # host catalog translation
    'butler-agent::host::guided::tools',         # dispatch and handler argument parsing
    'butler-agent::host::guided::project_tools',
    'butler-agent::host::guided::work_tools',
    'butler-agent::host::guided::registered_edit',
)
# Stub-tier E2E modules that drive model tool calls through dispatch and handlers.
E2E = ('tools', 'tools_effects', 'tools_direct_args', 'browser_tool_args',
       'memory_wiring_more', 'ask_user')


def module_base(root):
    crate, *modules = root.split('::')
    return '/'.join((RUST, 'crates', crate, 'src', *modules))


def selected(path):
    # A change to this definition also runs the set it defines.
    return path == '.github/scripts/ci_tool_path.py' or any(
        path == base + '.rs' or path.startswith(base + '/') for base in map(module_base, ROOTS))


def filterset():
    return 'binary(=e2e) and test(/^(' + '|'.join(E2E) + ')::/)'


if __name__ == '__main__':
    assert sys.argv[1:] == ['filterset'], sys.argv
    print(filterset())
