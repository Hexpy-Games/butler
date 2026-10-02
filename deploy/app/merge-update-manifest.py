#!/usr/bin/env python3
"""Merge successful App platforms without making another platform a prerequisite."""
import argparse
import hashlib
import json
from pathlib import Path


def merge(mac_manifest, linux_dir, version, base_url, windows_dir=None):
    manifest = json.loads(mac_manifest.read_text()) if mac_manifest else {"app_version": version, "artifacts": []}
    if manifest["app_version"] != version:
        raise ValueError("App version differs from the release tag")
    for platform in ("linux-x64", "linux-arm64"):
        name = f"butler-app-{version}-{platform}.deb"
        if not linux_dir:
            continue
        path = linux_dir / name
        if not path.is_file():
            continue
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
    if windows_dir:
        windows = json.loads((windows_dir / "app-update-manifest.json").read_text())
        if windows["app_version"] != version:
            raise ValueError("Windows App version differs from the release tag")
        for item in windows["artifacts"]:
            name = item["artifact_url"].rsplit("/", 1)[-1]
            with (windows_dir / name).open("rb") as artifact:
                digest = hashlib.file_digest(artifact, "sha256").hexdigest()
            if digest != item["sha256"]:
                raise ValueError("Windows App digest mismatch")
            manifest["artifacts"].append(item)
    platforms = [item["platform"] for item in manifest["artifacts"]]
    if len(platforms) != len(set(platforms)):
        raise ValueError("Duplicate App platform")
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("mac-manifest", "linux-dir", "windows-dir"):
        parser.add_argument(f"--{name}", type=Path)
    for name in ("output", "version", "base-url"):
        parser.add_argument(f"--{name}", required=True)
    args = parser.parse_args()
    manifest = merge(args.mac_manifest, args.linux_dir, args.version, args.base_url, args.windows_dir)
    Path(args.output).write_text(json.dumps(manifest, indent=2) + "\n")


if __name__ == "__main__":
    main()
