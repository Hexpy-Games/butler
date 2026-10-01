#!/usr/bin/env python3
"""Append the released Linux DEBs to the macOS App updater manifest."""
import argparse
import hashlib
import json
from pathlib import Path


def merge(mac_manifest, linux_dir, version, base_url):
    manifest = json.loads(mac_manifest.read_text())
    if manifest["app_version"] != version:
        raise ValueError("macOS App version differs from the release tag")
    for platform in ("linux-x64", "linux-arm64"):
        name = f"butler-app-{version}-{platform}.deb"
        path = linux_dir / name
        with path.open("rb") as artifact:
            digest = hashlib.file_digest(artifact, "sha256").hexdigest()
        recorded = path.with_suffix(".deb.sha256").read_text().split()[0]
        if digest != recorded:
            raise ValueError(f"Linux App digest mismatch: {name}")
        manifest["artifacts"].append({
            "component": "app", "product": "butler-app", "platform": platform,
            "version": version, "app_version": version, "bundled_agent_version": version,
            "channel": "preview" if "-" in version else "stable",
            "artifact_url": f"{base_url.rstrip('/')}/{name}", "sha256": digest,
            "package_format": "deb", "payload_format": "platform-app-package",
            "update_policy": "app-user-action", "restart_policy": "restart-app",
            "updater_owner": "butler-app", "staging_policy": "butler-data-updates",
            "activation_policy": "user-installs-app-package", "rollback_policy": "not-managed-by-butler",
        })
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("mac-manifest", "linux-dir", "output", "version", "base-url"):
        parser.add_argument(f"--{name}", required=True)
    args = parser.parse_args()
    manifest = merge(Path(args.mac_manifest), Path(args.linux_dir), args.version, args.base_url)
    Path(args.output).write_text(json.dumps(manifest, indent=2) + "\n")


if __name__ == "__main__":
    main()
