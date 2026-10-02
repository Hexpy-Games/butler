"""Fail closed when a private output path is inside the git worktree."""
from pathlib import Path


def private_output(path):
    root = Path(__file__).resolve().parents[2]
    path = Path(path).resolve()
    if path == root or root in path.parents:
        raise ValueError('conversation-derived files must stay outside the worktree')
    path.mkdir(parents=True, exist_ok=True)
    return path
