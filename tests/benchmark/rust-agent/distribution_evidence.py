"""Read-only executable and Mach-O dependency evidence for frozen artifacts."""

from __future__ import annotations

import hashlib
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
from typing import Any


BUN_PATH = Path("/opt/homebrew/bin/bun")
FILE_TOOL = "/usr/bin/file"
OTOOL = "/usr/bin/otool"
SYSTEM_LIBRARY_PREFIXES = (
    "/usr/lib/",
    "/System/Library/",
    "/System/Volumes/Preboot/Cryptexes/OS/usr/lib/",
)
RUNTIME_DEPENDENCY_NAMES = ("bun", "node", "nodejs", "libnode", "javascriptcore")


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def bun_executable_evidence() -> dict[str, Any]:
    """Hash the canonical target of the requested Homebrew Bun path; never run it."""
    try:
        canonical = BUN_PATH.resolve(strict=True)
        stat = canonical.stat()
        if not canonical.is_file() or not os.access(canonical, os.X_OK):
            raise OSError("not_executable")
        return {
            "status": "observed",
            "requested_path": str(BUN_PATH),
            "canonical_path": str(canonical),
            "sha256": _sha256_file(canonical),
            "size_bytes": stat.st_size,
        }
    except OSError:
        return {"status": "unavailable", "reason": "canonical_bun_executable_unavailable"}


def _run_text(command: list[str]) -> str:
    result = subprocess.run(command, capture_output=True, text=True, timeout=30, check=True)
    return result.stdout


def _is_macho(path: Path) -> bool:
    try:
        description = _run_text([FILE_TOOL, "-b", "-L", str(path)])
    except (OSError, subprocess.SubprocessError):
        raise RuntimeError("file_type_observation_unavailable") from None
    return "Mach-O" in description


def _macho_filetypes(path: Path) -> set[str]:
    output = _run_text([OTOOL, "-hv", str(path)])
    return {kind for kind in ("EXECUTE", "DYLIB", "BUNDLE")
            if re.search(rf"\b{kind}\b", output)}


def _macho_dependencies(path: Path) -> list[str]:
    output = _run_text([OTOOL, "-L", str(path)])
    dependencies = []
    for line in output.splitlines()[1:]:
        match = re.match(r"^\s*(.+?)\s+\(compatibility version\s", line)
        if match:
            dependencies.append(match.group(1).strip())
    return list(dict.fromkeys(dependencies))


def _macho_rpaths(path: Path) -> list[str]:
    output = _run_text([OTOOL, "-l", str(path)])
    return re.findall(
        r"(?m)^\s*cmd LC_RPATH\n\s*cmdsize \d+\n\s*path (.*?) \(offset \d+\)",
        output,
    )


def _expand_path(value: str, loader: Path, executable: Path) -> Path | None:
    if value.startswith("@loader_path"):
        suffix = value.removeprefix("@loader_path").removeprefix("/")
        return loader.parent / suffix
    if value.startswith("@executable_path"):
        suffix = value.removeprefix("@executable_path").removeprefix("/")
        return executable.parent / suffix
    if value.startswith("/"):
        return Path(value)
    return None


def _resolve_dependency(dependency: str, loader: Path, executable: Path,
                        root: Path, rpaths: list[Path]) -> tuple[str, Path | None]:
    if dependency.startswith(SYSTEM_LIBRARY_PREFIXES):
        return "system", None
    if dependency.startswith("@rpath/"):
        tail = dependency.removeprefix("@rpath/")
        candidates = [rpath / tail for rpath in rpaths]
        for candidate in candidates:
            if candidate.is_file():
                resolved = candidate.resolve(strict=True)
                if resolved.is_relative_to(root):
                    return "bundled", resolved
                if str(resolved).startswith(SYSTEM_LIBRARY_PREFIXES):
                    return "system", None
                return "external", resolved
        return "unresolved", None
    expanded = _expand_path(dependency, loader, executable)
    if expanded is None:
        return "unresolved", None
    if dependency.startswith(SYSTEM_LIBRARY_PREFIXES):
        return "system", None
    try:
        resolved = expanded.resolve(strict=True)
    except OSError:
        return "unresolved", None
    if resolved.is_relative_to(root):
        return "bundled", resolved
    if dependency.startswith(SYSTEM_LIBRARY_PREFIXES):
        return "system", None
    return "external", resolved


def inspect_distribution(installation_root: Path,
                         commands: list[list[str]]) -> dict[str, Any]:
    """Inventory launch executables and the transitive bundled/system dylib closure."""
    try:
        root = installation_root.resolve(strict=True)
        if not root.is_dir() or not commands:
            raise ValueError("invalid_installation")
        file_images: dict[Path, set[str]] = {}
        for candidate in sorted(root.rglob("*")):
            if candidate.is_symlink() or not candidate.is_file():
                continue
            if not (candidate.stat().st_mode & 0o111 or
                    candidate.suffix.lower() in {".dylib", ".so"}):
                continue
            if not _is_macho(candidate):
                continue
            file_images[candidate.resolve(strict=True)] = _macho_filetypes(candidate)

        launch_images: list[dict[str, Any]] = []
        roots: list[Path] = []
        unavailable_reasons: list[str] = []
        for index, command in enumerate(commands, start=1):
            executable_text = command[0].replace("{installation}", str(root))
            executable = Path(executable_text)
            try:
                image = executable.resolve(strict=True)
                if not image.is_file() or not os.access(image, os.X_OK) or not _is_macho(image):
                    raise OSError("not_macho_executable")
                filetypes = _macho_filetypes(image)
                if "EXECUTE" not in filetypes:
                    raise OSError("not_macho_executable")
                image_sha = _sha256_file(image)
                roots.append(image)
                launch_images.append({
                    "command_index": index,
                    "executable_name": image.name,
                    "artifact_relative_path": str(image.relative_to(root)) if image.is_relative_to(root) else None,
                    "sha256": image_sha,
                    "mach_o_filetypes": sorted(filetypes),
                })
            except (OSError, ValueError, subprocess.SubprocessError, RuntimeError):
                unavailable_reasons.append("launch_executable_inventory_unavailable")
                launch_images.append({"command_index": index, "status": "unavailable"})

        closure_edges: set[tuple[str, str, str, str | None]] = set()
        closure_status = "observed"
        visited: set[Path] = set()
        for root_executable in roots:
            pending: list[tuple[Path, list[Path]]] = [(root_executable, [])]
            while pending:
                image, inherited_rpaths = pending.pop()
                image = image.resolve(strict=True)
                if image in visited:
                    continue
                visited.add(image)
                try:
                    own_rpaths = []
                    for value in _macho_rpaths(image):
                        expanded = _expand_path(value, image, root_executable)
                        if expanded is not None:
                            own_rpaths.append(expanded)
                    search_rpaths = own_rpaths + inherited_rpaths
                    image_sha = _sha256_file(image)
                    dependencies = _macho_dependencies(image)
                except (OSError, subprocess.SubprocessError, RuntimeError):
                    closure_status = "unavailable"
                    unavailable_reasons.append("dylib_closure_tool_unavailable")
                    continue
                for dependency in dependencies:
                    kind, resolved = _resolve_dependency(
                        dependency, image, root_executable, root, search_rpaths,
                    )
                    dependency_name = PurePosixPath(dependency).name
                    dependency_sha: str | None = None
                    if kind == "bundled" and resolved is not None:
                        dependency_sha = _sha256_file(resolved)
                        pending.append((resolved, search_rpaths))
                    elif kind in {"external", "unresolved"}:
                        closure_status = "unavailable"
                        unavailable_reasons.append(
                            "external_dylib_dependency" if kind == "external"
                            else "dylib_dependency_unresolved"
                        )
                    closure_edges.add((image_sha, dependency_name, kind, dependency_sha))

        executable_count = sum("EXECUTE" in kinds for kinds in file_images.values())
        dylib_count = sum("DYLIB" in kinds for kinds in file_images.values())
        first_party_names = [name for _, name, _, _ in closure_edges
                             if any(token in name.lower() for token in RUNTIME_DEPENDENCY_NAMES)]
        first_party_names.extend(row["executable_name"] for row in launch_images
                                 if row.get("executable_name") and any(
                                     token in row["executable_name"].lower()
                                     for token in RUNTIME_DEPENDENCY_NAMES))
        first_party_status = "observed" if closure_status == "observed" else "unavailable"
        overall_status = "observed" if not unavailable_reasons else "unavailable"
        return {
            "status": overall_status,
            "executable_count": executable_count,
            "dylib_count": dylib_count,
            "mach_o_image_count": len(file_images),
            "launch_command_executables": launch_images,
            "dependency_closure": {
                "status": closure_status,
                "edge_count": len(closure_edges),
                "edges": [
                    {"from_sha256": source, "dependency_name": name,
                     "classification": kind, **({"bundled_sha256": digest} if digest else {})}
                    for source, name, kind, digest in sorted(closure_edges)
                ],
            },
            "first_party_backend_runtime_dependency": {
                "status": first_party_status,
                "present": bool(first_party_names) if first_party_status == "observed" else None,
                "matching_names": sorted(set(first_party_names)) if first_party_status == "observed" else [],
            },
            "unavailable_reasons": sorted(set(unavailable_reasons)),
        }
    except (OSError, ValueError, subprocess.SubprocessError, RuntimeError):
        return {
            "status": "unavailable",
            "executable_count": None,
            "dylib_count": None,
            "mach_o_image_count": None,
            "launch_command_executables": [],
            "dependency_closure": {"status": "unavailable", "edge_count": None, "edges": []},
            "first_party_backend_runtime_dependency": {
                "status": "unavailable", "present": None, "matching_names": [],
            },
            "unavailable_reasons": ["distribution_inventory_unavailable"],
        }
