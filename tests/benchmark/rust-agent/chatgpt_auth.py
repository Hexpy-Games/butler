"""Check an explicitly supplied ChatGPT registration through the redacted CLI."""
import json
import os
from pathlib import Path
import subprocess
import stat
import tempfile


def chatgpt_auth_input(auth_dir: Path, executable: Path) -> dict:
    if not auth_dir.is_dir() or not (auth_dir / "chatgpt.json").is_file():
        raise ValueError("ChatGPT auth directory must contain chatgpt.json")
    for path in (auth_dir, auth_dir / "chatgpt.json"):
        metadata = path.lstat()
        if stat.S_ISLNK(metadata.st_mode) or metadata.st_mode & 0o077:
            raise ValueError("ChatGPT auth input must be private and not a symbolic link")
    # Never deserialize, hash, copy or print credentials. The CLI owns status reads.
    with tempfile.TemporaryDirectory(prefix="butler-chatgpt-status-") as scratch:
        env = {key: value for key, value in os.environ.items()
               if key in {"PATH", "SYSTEMROOT", "TMPDIR", "LANG", "LC_ALL"}}
        env.update(HOME=scratch, BUTLER_DATA=scratch,
                   BUTLER_CHATGPT_AUTH_DIR=str(auth_dir))
        try:
            result = subprocess.run(
                [str(executable), "auth", "status", "--json", "--data", scratch],
                env=env, capture_output=True, text=True, check=False, timeout=30,
            )
            payload = json.loads(result.stdout)
            status = payload.get("data") if isinstance(payload, dict) else None
            if not isinstance(status, dict):
                raise ValueError("invalid status response")
        except (OSError, ValueError, subprocess.TimeoutExpired):
            raise ValueError("ChatGPT auth status unavailable") from None
        if result.returncode or status.get("configured") is not True or \
           status.get("mode") != "chatgpt_plan":
            raise ValueError("ChatGPT sign-in with plan use enabled is required")
    return {"mode": "chatgpt_oauth", "auth_dir": str(auth_dir)}
