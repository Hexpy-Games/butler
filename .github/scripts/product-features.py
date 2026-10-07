#!/usr/bin/env python3
"""Select product features for an exact release tag or its release branch."""
import argparse
import json
import os
from pathlib import Path
import re


def release_features(root, tag):
    if not re.fullmatch(r"v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?", tag):
        return {"browser": True}
    source = root / ".github" / "releases" / f"{tag}.features.json"
    if not source.exists():
        return {"browser": True}
    features = json.loads(source.read_text(encoding="utf-8"))
    if set(features) != {"browser"} or type(features["browser"]) is not bool:
        raise ValueError(f"Invalid product features: {source.name}")
    return features


def artifact_tag(tag, ref, base_ref=""):
    if tag:
        return tag
    if ref.startswith("refs/tags/"):
        return ref.removeprefix("refs/tags/")
    if ref.startswith("refs/heads/release/"):
        return "v" + ref.removeprefix("refs/heads/release/")
    if ref.startswith("refs/pull/") and base_ref.startswith("release/"):
        return "v" + base_ref.removeprefix("release/")
    return ""


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag", default="")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[2])
    args = parser.parse_args()
    tag = artifact_tag(args.tag, os.environ.get("GITHUB_REF", ""),
                       os.environ.get("GITHUB_BASE_REF", ""))
    features = release_features(args.root, tag)
    value = str(features["browser"]).lower()
    print(json.dumps(features))
    if os.environ.get("GITHUB_ENV"):
        with open(os.environ["GITHUB_ENV"], "a", encoding="utf-8") as env:
            env.write(f"BUTLER_FEATURE_BROWSER={value}\n")
