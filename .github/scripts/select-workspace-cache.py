"""Select the newest compatible source snapshot visible to this workflow ref."""
import json
import os
from pathlib import Path
import re
import subprocess

base = os.environ["WORKSPACE_CACHE_BASE"]
node_os = {"Linux": "Linux", "macOS": "Darwin", "Windows": "Windows_NT"}[os.environ["RUNNER_OS"]]
node_arch = os.environ["RUNNER_ARCH"].lower()
pattern = re.compile(re.escape("v0-rust-" + base) + r"([a-f0-9]{64})-" +
                     re.escape(node_os + "-" + node_arch) + r"-.+")
refs = {os.environ["GITHUB_REF"], "refs/heads/" + os.environ["DEFAULT_BRANCH"]}
candidates = []
for ref in sorted(refs):
    result = subprocess.run([
        "gh", "api", "--method", "GET",
        "repos/" + os.environ["GITHUB_REPOSITORY"] + "/actions/caches",
        "-f", "ref=" + ref, "-f", "key=v0-rust-" + base,
        "-f", "sort=created_at", "-f", "direction=desc", "-f", "per_page=100",
    ], text=True, capture_output=True)
    if result.returncode:
        print("::warning::Source cache metadata unavailable; using the dependency fallback")
        continue
    for cache in json.loads(result.stdout)["actions_caches"]:
        match = pattern.fullmatch(cache["key"])
        if match and cache["ref"] == ref:
            candidates.append((cache["created_at"], base + match.group(1)))
selected = max(candidates)[1] if candidates else ""
with Path(os.environ["GITHUB_OUTPUT"]).open("a") as output:
    output.write("shared-key=" + selected + "\n")
print("Compatible workspace snapshot found" if selected else "No prior source snapshot; using the dependency fallback")
