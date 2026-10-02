"""Pluggable text-only Luna calls. Inputs and raw outputs stay private."""
import json
import hashlib
import subprocess
from privacy import private_output


def call(prompt, directory, name):
    directory = private_output(directory)
    directory.mkdir(parents=True, exist_ok=True)
    source = directory / f"{name}.prompt.txt"
    output = directory / f"{name}.output.txt"
    content = "Do not run commands or use tools. Text generation only. Return JSON only.\n" + prompt
    if output.exists() and (not source.exists() or source.read_text() != content):
        name += "-" + hashlib.sha256(content.encode()).hexdigest()[:12]
        source = directory / f"{name}.prompt.txt"
        output = directory / f"{name}.output.txt"
        if output.exists() and source.read_text() != content:
            raise ValueError("prompt hash collision")
    source.write_text(content)
    if not output.exists():
        with (directory / f"{name}.log").open("w") as log:
            result = subprocess.run([
                "codex", "exec", "-m", "gpt-6-luna", "-c", "model_reasoning_effort=high",
                "--skip-git-repo-check", "-s", "read-only", "--output-last-message", str(output),
                "Read the following task as pure text; do not use any tools:\n" + source.read_text(),
            ], stdin=subprocess.DEVNULL, stdout=log, stderr=log, cwd=directory)
        if result.returncode:
            pending = directory.parent / "pending"
            pending.mkdir(exist_ok=True)
            (pending / source.name).write_text(source.read_text())
            raise RuntimeError(f"model call failed: {name}; see private log")
    text = output.read_text().strip()
    if text.startswith("```"):
        text = text[text.index("\n") + 1:text.rindex("```")]
    return json.loads(text)
