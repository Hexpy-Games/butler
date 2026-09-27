#!/usr/bin/env python3
"""Package an already-built native Agent payload; this script never builds it."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tarfile
import tempfile


SCHEMA = "butler.native-agent-install.v1"
PAYLOAD_SCHEMA = "butler.native-agent-payload.v1"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--payload", required=True, type=Path, help="prepared native payload directory")
    parser.add_argument("--output", required=True, type=Path, help="standalone .tar.gz destination")
    parser.add_argument("--artifact-url", help="published URL for the independently installed archive")
    parser.add_argument("--channel", default="stable", help="update channel in the Agent manifest")
    args = parser.parse_args()
    if not args.channel.strip():
        parser.error("Agent update channel is empty")
    if args.artifact_url is not None and not args.artifact_url.startswith(("https://", "file://")):
        parser.error("--artifact-url must be https:// or file://")

    payload = args.payload.resolve(strict=True)
    output = args.output.absolute()
    if output.exists() and output.is_dir():
        parser.error("--output must be an archive file path")
    source_manifest = payload / "native-agent-manifest.json"
    manifest = read_payload_manifest(source_manifest)
    binary_source = checked_payload_path(payload, manifest.get("binary"), "bin/butler-agent")
    resources_source = checked_payload_path(payload, manifest.get("resources"), "resources")
    if not binary_source.is_file() or not resources_source.is_dir():
        parser.error("prepared payload must contain its native binary and resources directory")
    validate_resource_symlinks(resources_source)
    verify_macos_arm64(binary_source)

    version = nonempty(manifest.get("version"), "Agent version")
    app_version = optional_text(manifest.get("appVersion"))
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="butler-native-agent-") as temporary:
        stage = Path(temporary) / "butler-agent-standalone"
        stage.mkdir(mode=0o755)
        binary = stage / "butler-agent"
        shutil.copyfile(binary_source, binary)
        binary.chmod(0o555)
        shutil.copytree(resources_source, stage / "resources", symlinks=True)
        make_read_only(stage / "resources")
        (stage / "butler").symlink_to("butler-agent")
        standalone_manifest = {
            "schema": SCHEMA,
            "version": version,
            "appVersion": app_version,
            "platform": "darwin",
            "architecture": "arm64",
            "binary": "butler-agent",
            "resources": "resources",
            "launcher": "butler",
            "binarySha256": sha256_file(binary),
            "resourcesSha256": sha256_tree(stage / "resources"),
        }
        (stage / "native-agent-manifest.json").write_text(
            json.dumps(standalone_manifest, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        (stage / "native-agent-manifest.json").chmod(0o444)
        write_deterministic_archive(stage, output)
    write_agent_manifests(
        output,
        version=version,
        app_version=app_version,
        channel=args.channel,
        artifact_url=args.artifact_url,
    )
    print(output)
    return 0


def write_agent_manifests(
    archive: Path, *, version: str, app_version: str | None, channel: str, artifact_url: str | None
) -> None:
    """Emit the native Agent artifact as its own update/release unit."""
    digest = sha256_file(archive)
    artifact = {
        "component": "service",
        "canonical_component": "agent",
        "product": "butler-agent",
        "profile": "agent-standalone",
        "version": version,
        "app_version": app_version,
        "channel": channel.strip(),
        "platform": "darwin-arm64",
        "artifact_name": archive.name,
        "artifact_url": artifact_url,
        "sha256": digest,
        "integrity": {"digestAlgorithm": "sha256", "digest": digest, "signature": None},
        "bundled_components": ["service"],
        "protocol_compatibility": {
            "protocol": "butler.agent.v1",
            "minimumAgentProtocol": "butler.agent.v1",
            "maximumAgentProtocol": "butler.agent.v1",
        },
        "update_policy": "explicit",
        "restart_policy": "restart-service",
        "updater_owner": "butler-agent",
        "payload_format": "agent-archive",
        "staging_policy": "butler-data-updates",
        "activation_policy": "user-installs-standalone-archive",
        "rollback_policy": "not-managed-by-butler",
    }
    release_envelope = {
        "schema": "butler.agent-release-manifest.v1",
        "name": "butler-agent",
        "product": "butler-agent",
        "version": version,
        "artifacts": [artifact],
    }
    update_envelope = {
        "schema": "butler.update-manifest.v1",
        "product": "butler-agent",
        "agent_version": version,
        "artifacts": [artifact],
    }
    for name, envelope in (
        ("agent-release-manifest.json", release_envelope),
        ("agent-update-manifest.json", update_envelope),
    ):
        destination = archive.parent / name
        destination.write_text(json.dumps(envelope, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def read_payload_manifest(path: Path) -> dict:
    if path.is_symlink() or not path.is_file():
        raise SystemExit("prepared native payload manifest is missing or aliased")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise SystemExit("prepared native payload manifest is invalid") from error
    if not isinstance(value, dict) or value.get("schema") != PAYLOAD_SCHEMA:
        raise SystemExit("unsupported prepared native payload manifest")
    if value.get("platform") != "darwin" or value.get("architecture") != "arm64":
        raise SystemExit("prepared payload must target macOS arm64")
    return value


def checked_payload_path(root: Path, value: object, expected: str) -> Path:
    if value != expected:
        raise SystemExit(f"prepared payload path must be {expected}")
    relative = PurePosixPath(expected)
    if relative.is_absolute() or any(part in ("", ".", "..") for part in relative.parts):
        raise SystemExit("prepared payload path is unsafe")
    path = root.joinpath(*relative.parts)
    current = root
    for part in relative.parts:
        current /= part
        if current.is_symlink():
            raise SystemExit("prepared payload path contains a symlink")
    resolved = path.resolve(strict=True)
    if not resolved.is_relative_to(root):
        raise SystemExit("prepared payload path escapes its root")
    return resolved


def validate_resource_symlinks(root: Path) -> None:
    for current, directories, files in os.walk(root, followlinks=False):
        parent = Path(current)
        for name in [*directories, *files]:
            path = parent / name
            if not path.is_symlink():
                continue
            target = os.readlink(path)
            resolved = (path.parent / target).resolve(strict=False)
            if Path(target).is_absolute() or not resolved.is_relative_to(root):
                raise SystemExit("resource payload contains an escaping symlink")


def verify_macos_arm64(binary: Path) -> None:
    try:
        architectures = subprocess.run(
            ["/usr/bin/lipo", "-archs", str(binary)],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.split()
        dependencies = subprocess.run(
            ["/usr/bin/otool", "-L", str(binary)],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.splitlines()[1:]
    except (OSError, subprocess.CalledProcessError) as error:
        raise SystemExit("native binary architecture/dependency inspection failed") from error
    if architectures != ["arm64"]:
        raise SystemExit("native binary must contain only the macOS arm64 architecture")
    unsupported = [
        line.strip().split(" ", 1)[0]
        for line in dependencies
        if line.strip()
        and not line.strip().split(" ", 1)[0].startswith(("/usr/lib/", "/System/Library/"))
    ]
    if unsupported:
        raise SystemExit("native binary has a non-system dynamic dependency")


def make_read_only(root: Path) -> None:
    for current, directories, files in os.walk(root, followlinks=False):
        current_path = Path(current)
        current_path.chmod(0o555)
        for name in files:
            path = current_path / name
            if not path.is_symlink():
                path.chmod(0o555 if path.stat().st_mode & 0o111 else 0o444)
        for name in directories:
            path = current_path / name
            if not path.is_symlink():
                path.chmod(0o555)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_tree(root: Path) -> str:
    digest = hashlib.sha256()

    def visit(directory: Path, relative: str = "") -> None:
        for path in sorted(directory.iterdir(), key=lambda item: item.name):
            label = f"{relative}/{path.name}" if relative else path.name
            if path.is_symlink():
                digest.update(f"l:{label}:{os.readlink(path)}\n".encode())
            elif path.is_dir():
                digest.update(f"d:{label}\n".encode())
                visit(path, label)
            elif path.is_file():
                digest.update(f"f:{label}\n".encode())
                with path.open("rb") as source:
                    for chunk in iter(lambda: source.read(1024 * 1024), b""):
                        digest.update(chunk)
            else:
                raise SystemExit(f"unsupported resource payload entry: {label}")

    visit(root)
    return digest.hexdigest()


def write_deterministic_archive(stage: Path, output: Path) -> None:
    with output.open("wb") as destination:
        with gzip.GzipFile(fileobj=destination, mode="wb", mtime=0, filename="") as compressed:
            with tarfile.open(fileobj=compressed, mode="w") as archive:
                for path in sorted(stage.rglob("*"), key=lambda item: item.relative_to(stage).as_posix()):
                    archive.add(
                        path,
                        arcname=path.relative_to(stage).as_posix(),
                        recursive=False,
                        filter=normalized_tar_info,
                    )


def normalized_tar_info(info: tarfile.TarInfo) -> tarfile.TarInfo:
    info.uid = 0
    info.gid = 0
    info.uname = ""
    info.gname = ""
    info.mtime = 0
    return info


def nonempty(value: object, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise SystemExit(f"prepared payload {label} is missing")
    return value.strip()


def optional_text(value: object) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


if __name__ == "__main__":
    raise SystemExit(main())
