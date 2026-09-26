#!/usr/bin/env python3
"""Validate a prepared native payload or smoke an immutable standalone archive."""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile


PACKAGER_PATH = Path(__file__).with_name("package-standalone-macos-arm64.py")
SPEC = importlib.util.spec_from_file_location("native_standalone_packager", PACKAGER_PATH)
assert SPEC and SPEC.loader
packager = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(packager)


def payload_gate(payload: Path) -> dict:
    root = payload.resolve(strict=True)
    manifest = packager.read_payload_manifest(root / "native-agent-manifest.json")
    binary = packager.checked_payload_path(root, manifest.get("binary"), "bin/butler-agent")
    resources = packager.checked_payload_path(root, manifest.get("resources"), "resources")
    if not binary.is_file() or not resources.is_dir():
        raise SystemExit("native payload binary or resources missing")
    packager.validate_resource_symlinks(resources)
    packager.verify_macos_arm64(binary)
    return {
        "schema": "butler.native-agent-release-gate.v1",
        "version": packager.nonempty(manifest.get("version"), "Agent version"),
        "binarySha256": packager.sha256_file(binary),
        "resourcesSha256": packager.sha256_tree(resources),
        "architecture": "darwin-arm64",
        "status": "passed",
    }


def _release_manifests(
    archive: Path,
    version: str,
    app_version: str | None,
    expected_artifact_url: str | None,
) -> None:
    digest = packager.sha256_file(archive)
    artifact_urls: list[str | None] = []
    for filename, schema in (
        ("agent-release-manifest.json", "butler.agent-release-manifest.v1"),
        ("agent-update-manifest.json", "butler.update-manifest.v1"),
    ):
        path = archive.parent / filename
        if path.is_symlink() or not path.is_file():
            raise SystemExit(f"{filename} missing or aliased")
        try:
            envelope = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise SystemExit(f"{filename} is invalid") from error
        if not isinstance(envelope, dict) or envelope.get("schema") != schema:
            raise SystemExit(f"{filename} envelope invalid")
        release_identity = (
            envelope.get("name") == "butler-agent"
            and envelope.get("product") == "butler-agent"
            and envelope.get("version") == version
        )
        update_identity = (
            envelope.get("product") == "butler-agent"
            and envelope.get("agent_version") == version
        )
        if (filename == "agent-release-manifest.json" and not release_identity) or (
            filename == "agent-update-manifest.json" and not update_identity
        ):
            raise SystemExit(f"{filename} release identity mismatch")
        artifacts = envelope.get("artifacts")
        if not isinstance(artifacts, list) or len(artifacts) != 1 or not isinstance(artifacts[0], dict):
            raise SystemExit(f"{filename} artifact list invalid")
        artifact = artifacts[0]
        integrity = artifact.get("integrity")
        artifact_url = artifact.get("artifact_url")
        if artifact_url is not None and not isinstance(artifact_url, str):
            raise SystemExit(f"{filename} artifact URL is invalid")
        if (artifact.get("component") != "service"
                or artifact.get("canonical_component") != "agent"
                or artifact.get("product") != "butler-agent"
                or artifact.get("profile") != "agent-standalone"
                or artifact.get("version") != version
                or artifact.get("app_version") != app_version
                or artifact.get("sha256") != digest
                or not isinstance(integrity, dict)
                or integrity.get("digestAlgorithm") != "sha256"
                or integrity.get("digest") != digest
                or integrity.get("signature") is not None
                or artifact.get("artifact_name") != archive.name
                or (expected_artifact_url is not None and artifact_url != expected_artifact_url)
                or artifact.get("platform") != "darwin-arm64"
                or artifact.get("payload_format") != "agent-archive"
                or artifact.get("update_policy") != "explicit"
                or artifact.get("restart_policy") != "restart-service"
                or artifact.get("updater_owner") != "butler-agent"):
            raise SystemExit(f"{filename} artifact digest or identity mismatch")
        artifact_urls.append(artifact_url)
    if artifact_urls[0] != artifact_urls[1]:
        raise SystemExit("Agent release manifests disagree on the artifact URL")


def _extract_archive(archive: Path, destination: Path) -> None:
    if not hasattr(tarfile, "data_filter"):
        raise SystemExit("Python 3.12 or newer is required for safe archive extraction")
    entries: dict[str, tarfile.TarInfo] = {}
    allowed_roots = {"butler-agent", "butler", "resources", "native-agent-manifest.json"}
    with tarfile.open(archive, "r:gz") as source:
        for member in source.getmembers():
            raw_name = member.name
            if "\\" in raw_name or raw_name.startswith("/"):
                raise SystemExit("native archive contains an unsafe entry")
            parts = raw_name.split("/")
            if member.isdir() and parts[-1] == "":
                parts.pop()
            if (not parts or any(part in ("", ".", "..") for part in parts)
                    or parts[0] not in allowed_roots):
                raise SystemExit("native archive contains an unsafe entry")
            name = "/".join(parts)
            if name in entries or member.islnk():
                raise SystemExit("native archive contains a duplicate or hard-linked entry")
            if name == "butler-agent" or name == "native-agent-manifest.json":
                valid_type = member.isfile()
            elif name == "butler":
                valid_type = member.issym() and member.linkname == "butler-agent"
            elif name == "resources":
                valid_type = member.isdir()
            elif name.startswith("resources/"):
                valid_type = member.isfile() or member.isdir() or member.issym()
            else:
                valid_type = False
            if not valid_type:
                raise SystemExit("native archive contains an unexpected entry type")
            if member.issym() and name.startswith("resources/"):
                if (not member.linkname or "\\" in member.linkname
                        or member.linkname.startswith("/")):
                    raise SystemExit("native archive contains an escaping resource symlink")
                target_parts = list(parts[:-1])
                for part in member.linkname.split("/"):
                    if part in ("", "."):
                        continue
                    if part == "..":
                        if len(target_parts) == 1:
                            raise SystemExit("native archive contains an escaping resource symlink")
                        target_parts.pop()
                    else:
                        target_parts.append(part)
                if target_parts[0] != "resources":
                    raise SystemExit("native archive contains an escaping resource symlink")
            entries[name] = member

        required = {"butler-agent", "butler", "resources", "native-agent-manifest.json"}
        if not required.issubset(entries):
            raise SystemExit("native archive is missing a required installation entry")
        for name in entries:
            parent = name.split("/")[:-1]
            while parent:
                parent_name = "/".join(parent)
                parent_entry = entries.get(parent_name)
                if parent_entry is not None and not parent_entry.isdir():
                    raise SystemExit("native archive entry is nested beneath a non-directory")
                parent.pop()
        source.extractall(destination, filter="data")


def archive_smoke(archive: Path, expected_artifact_url: str | None = None) -> dict:
    if archive.is_symlink() or not archive.is_file():
        raise SystemExit("native archive is missing or aliased")
    archive = archive.resolve(strict=True)
    archive_digest = packager.sha256_file(archive)
    with tempfile.TemporaryDirectory(prefix="butler-native-release-smoke-") as temporary:
        root = Path(temporary)
        installation = root / "installation"
        installation.mkdir()
        _extract_archive(archive, installation)
        manifest_path = installation / "native-agent-manifest.json"
        if manifest_path.is_symlink() or not manifest_path.is_file():
            raise SystemExit("installed native manifest missing or aliased")
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise SystemExit("installed native manifest is invalid") from error
        if not isinstance(manifest, dict):
            raise SystemExit("installed native manifest is invalid")
        binary = installation / "butler-agent"
        resources = installation / "resources"
        launcher = installation / "butler"
        if (manifest.get("schema") != packager.SCHEMA or
                manifest.get("platform") != "darwin" or
                manifest.get("architecture") != "arm64" or
                manifest.get("binary") != "butler-agent" or
                manifest.get("resources") != "resources" or
                manifest.get("launcher") != "butler" or
                not binary.is_file() or binary.is_symlink() or not resources.is_dir() or resources.is_symlink() or
                not launcher.is_symlink() or os.readlink(launcher) != "butler-agent"):
            raise SystemExit("standalone installation layout invalid")
        packager.validate_resource_symlinks(resources)
        packager.verify_macos_arm64(binary)
        if (packager.sha256_file(binary) != manifest.get("binarySha256") or
                packager.sha256_tree(resources) != manifest.get("resourcesSha256")):
            raise SystemExit("standalone installation checksum mismatch")
        version = packager.nonempty(manifest.get("version"), "Agent version")
        app_version = packager.optional_text(manifest.get("appVersion"))
        _release_manifests(archive, version, app_version, expected_artifact_url)
        before = packager.sha256_tree(installation)
        data = root / "data"
        data.mkdir()
        environment = {key: value for key, value in os.environ.items() if not key.startswith("BUTLER_")}
        environment.update({"HOME": str(root / "home"), "BUTLER_DATA": str(data)})
        (root / "home").mkdir()
        for command in (
            ["version", "--json"],
            ["doctor", "--check", "installation", "--json"],
        ):
            result = subprocess.run(
                [str(launcher), "--data", str(data), *command], cwd=root,
                env=environment, capture_output=True, text=True, timeout=30,
            )
            if result.returncode != 0:
                raise SystemExit(f"native {command[0]} smoke failed: {result.stderr.strip()}")
            value = json.loads(result.stdout)
            if value.get("ok") is not True or not isinstance(value.get("data"), dict):
                raise SystemExit(f"native {command[0]} response envelope invalid")
            if command[0] == "version":
                version_data = value["data"]
                installation_data = version_data.get("installation")
                runtime_data = version_data.get("runtime")
                if not isinstance(installation_data, dict) or not isinstance(runtime_data, dict):
                    raise SystemExit("native version provenance is missing")
                if (version_data.get("version") != version
                        or version_data.get("appVersion") != app_version
                        or version_data.get("availability") != "installed_manifest"
                        or runtime_data.get("kind") != "native"
                        or runtime_data.get("source") != "installed_executable"
                        or installation_data.get("schema") != packager.SCHEMA
                        or installation_data.get("platform") != "darwin"
                        or installation_data.get("architecture") != "arm64"
                        or installation_data.get("binary") != "butler-agent"
                        or installation_data.get("resources") != "resources"
                        or installation_data.get("launcher") != "butler"
                        or installation_data.get("binarySha256") != manifest["binarySha256"]
                        or installation_data.get("resourcesSha256") != manifest["resourcesSha256"]):
                    raise SystemExit("native version provenance mismatch")
            else:
                doctor_data = value["data"]
                checks = doctor_data.get("checks")
                if (doctor_data.get("schema") != "butler.native-doctor.v1"
                        or doctor_data.get("status") != "healthy"
                        or doctor_data.get("exitCode") != 0
                        or not isinstance(checks, list)
                        or len(checks) != 4):
                    raise SystemExit("native doctor response is unhealthy or invalid")
                check_results = {
                    check.get("id"): check.get("status")
                    for check in checks if isinstance(check, dict)
                }
                if check_results != {
                    "executable": "pass",
                    "resources": "pass",
                    "version": "pass",
                    "integrity": "pass",
                }:
                    raise SystemExit("native doctor installation checks did not all pass")
        if packager.sha256_tree(installation) != before:
            raise SystemExit("native smoke changed its installed package")
        if packager.sha256_file(archive) != archive_digest:
            raise SystemExit("native smoke archive changed while being checked")
        return {"schema": "butler.native-agent-release-smoke.v1",
                "status": "passed", "version": version,
                "archiveSha256": archive_digest,
                "binarySha256": manifest["binarySha256"],
                "installationSha256": before}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("gate").add_argument("--payload", type=Path, required=True)
    smoke = commands.add_parser("smoke")
    smoke.add_argument("--archive", type=Path, required=True)
    smoke.add_argument("--artifact-url", help="expected published URL recorded in both release manifests")
    args = parser.parse_args()
    if args.command == "gate":
        result = payload_gate(args.payload)
    else:
        if args.artifact_url is not None and not args.artifact_url.strip():
            parser.error("--artifact-url cannot be empty")
        result = archive_smoke(args.archive, args.artifact_url)
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
