#!/usr/bin/env python3
"""Select product features for one exact release tag; branches default to on."""
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


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag", default="")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[2])
    args = parser.parse_args()
    tag = args.tag or (os.environ.get("GITHUB_REF_NAME", "")
                       if os.environ.get("GITHUB_REF", "").startswith("refs/tags/") else "")
    features = release_features(args.root, tag)
    value = str(features["browser"]).lower()
    print(json.dumps(features))
    if os.environ.get("GITHUB_ENV"):
        with open(os.environ["GITHUB_ENV"], "a", encoding="utf-8") as env:
            env.write(f"BUTLER_FEATURE_BROWSER={value}\n")
