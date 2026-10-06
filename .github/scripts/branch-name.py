#!/usr/bin/env python3
"""Enforce work/release branch names on every PR, including fork PRs."""
import re
import sys

PATTERN = r'(feat|fix|perf|refactor|ci|build|docs|test|chore|research)/[a-z0-9][a-z0-9._-]*|release/\d+\.\d+\.\d+(-preview\.\d+)?'


def valid(name):
    return re.fullmatch(PATTERN, name) is not None


if __name__ == '__main__':
    if not valid(sys.argv[1]):
        sys.exit('Use <type>/<slug> or release/<version>; tool-named branches are forbidden.')
