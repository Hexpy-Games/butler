#!/usr/bin/env python3
"""Refresh reviewed license evidence from locked source packages (network allowed).

No installed license tool is needed: Python 3.11+, Node and the repo's Cargo
toolchain suffice. Release builds use generate.mjs and never fetch evidence.
"""
from disclosure import disclose

import concurrent.futures
import hashlib
import json
import os
import re
import subprocess
import tomllib
import urllib.error
import urllib.request
import zipfile
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RUST = ROOT / "packages/butler-agent/rust"
TARGETS = {
    "aarch64-apple-darwin": "macOS App/Agent",
    "x86_64-unknown-linux-gnu": "Linux x64 DEB/Arch/Agent",
    "aarch64-unknown-linux-gnu": "Linux arm64 DEB/Agent",
    "x86_64-pc-windows-msvc": "Unsigned Windows x64 Agent preview",
}
SIBLING_LICENSES = {}


def run(*args):
    return subprocess.check_output(args, cwd=ROOT, text=True)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def fetch(url):
    cache = Path("/tmp/butler-license-evidence")
    cache.mkdir(exist_ok=True)
    saved = cache / digest(url.encode())
    if saved.exists():
        value = saved.read_text()
        return value or None
    try:
        with urllib.request.urlopen(url, timeout=60) as response:
            text = response.read().decode("utf-8")
            saved.write_text(text)
            return text
    except urllib.error.HTTPError as error:
        if error.code == 404:
            saved.write_text("")
            return None
        raise RuntimeError(f"License evidence fetch failed: {url}: HTTP {error.code}") from error


def license_files(directory):
    files = sorted(p for p in directory.rglob("*") if p.is_file()
                   and re.match(r"^(licen[cs]e|copying|notice|copyright)([._-]|$)", p.name, re.I))
    result = []
    for file in files:
        text = file.read_text(encoding="utf-8")
        if text.strip():
            result.append((str(file.relative_to(directory)), text))
    return result


def record(kind, name, version, license_id, source, artifacts, files, **extra):
    if license_id:
        license_id = re.sub(r"\s*/\s*", " OR ", license_id)
    keys = []
    for label, text in files:
        evidence = f"{text.strip()}\n"
        key = digest(evidence.encode())
        keys.append(key)
    if not keys:
        raise ValueError(f"Missing full license text: {name} {version}")
    return disclose(dict(id=f"{kind}:{name}@{version}", name=name, version=version,
                license=license_id, source=source, artifacts=artifacts,
                evidenceSha256=keys, files=[label for label, _ in files], **extra), [text for _, text in files])


def crate_evidence(package):
    directory = Path(package["manifest_path"]).parent
    files = license_files(directory)
    license_id = package["license"]
    if not license_id and files and "UNICODE LICENSE V3" in files[0][1]:
        license_id = "Unicode-3.0"  # ICU 1.x declares license-file, not license.
    source = package.get("repository") or "https://crates.io/crates/" + package["name"]
    if not files:
        files = SIBLING_LICENSES.get(source.rstrip("/"), [])
    vcs = directory / ".cargo_vcs_info.json"
    if source.startswith("https://github.com/"):
        revision = json.loads(vcs.read_text())["git"]["sha1"] if vcs.exists() else package["version"]
        repository = source.removesuffix(".git").rstrip("/")
        repository = "/".join(repository.split("/")[:5])
        raw = repository.replace("https://github.com/", "https://raw.githubusercontent.com/")
        source = f"{repository}/tree/{revision}"
        if not files:
            for filename in ("LICENSE", "LICENSE-MIT", "LICENSE-APACHE", "LICENSE.txt", "LICENSE.md", "COPYING"):
                text = fetch(f"{raw}/{revision}/{filename}")
                if text:
                    files.append((f"{source}/{filename}", text))
        if not files:
            tree = fetch(f"https://api.github.com/repos/{'/'.join(repository.split('/')[-2:])}/git/trees/{revision}?recursive=1")
            paths = json.loads(tree)["tree"] if tree else []
            for entry in paths:
                path = entry["path"]
                if entry["type"] == "blob" and re.match(r"^(licen[cs]e|copying|notice)([._-]|$)", Path(path).name, re.I):
                    text = fetch(f"{raw}/{revision}/{path}")
                    if text:
                        files.append((f"{source}/{path}", text))
        if "Apache" in (license_id or ""):
            notice = fetch(f"{raw}/{revision}/NOTICE")
            if notice:
                files.append((f"{source}/NOTICE", notice))
    # Generated Lance client has no repository metadata but belongs to Lance namespace.
    if not files and package["name"] == "lance-namespace-reqwest-client":
        revision = json.loads(vcs.read_text())["git"]["sha1"]
        source = f"https://github.com/lance-format/lance-namespace/tree/{revision}"
        text = fetch(f"https://raw.githubusercontent.com/lance-format/lance-namespace/{revision}/LICENSE")
        if text:
            files.append(("lance-namespace v0.6.1 LICENSE", text))
    if not files and package["name"] == "htmlescape":
        # Upstream declares Apache as an alternative but omits a license file.
        # Elect Apache; preserve the declaration and provide the full license.
        license_id = "Apache-2.0"
        source = "https://crates.io/crates/htmlescape/0.3.1"
        text = fetch("https://raw.githubusercontent.com/spdx/license-list-data/v3.27.0/text/Apache-2.0.txt")
        files = [("Apache-2.0 (elected from upstream Apache-2.0 / MIT / MPL-2.0)", text),
                 ("Upstream package declaration", (directory / "Cargo.toml").read_text())]
    if package["name"] == "random_word":
        base = "https://raw.githubusercontent.com/MitchellRhysHall/random_word/dc1cab8d7951ff4285ea9158c8954d663fdd6fbf"
        files = [(f"{base}/src/license/en.txt", fetch(f"{base}/src/license/en.txt")),
                 ("Upstream MIT declaration (no copyright notice supplied)", (directory / "Cargo.toml").read_text()),
                 ("Full MIT license (upstream omits text)", fetch("https://raw.githubusercontent.com/spdx/license-list-data/v3.27.0/text/MIT.txt"))]
    if not files and package["name"] == "windows-permissions" and package["version"] == "0.2.4" and license_id == "MIT":
        # The published package and pinned upstream both declare MIT but omit
        # its text and copyright notice. Preserve that declaration verbatim;
        # provide the standard text without inventing a copyright attribution.
        source = "https://crates.io/crates/windows-permissions/0.2.4"
        files = [("Upstream MIT declaration (no copyright notice supplied)", (directory / "Cargo.toml.orig").read_text()),
                 ("Full MIT license (upstream omits text)", fetch("https://raw.githubusercontent.com/spdx/license-list-data/v3.27.0/text/MIT.txt"))]
    return package, license_id, source, files


def rust_components():
    metadata = json.loads(run("cargo", "metadata", "--locked", "--format-version", "1",
                              "--manifest-path", str(RUST / "Cargo.toml")))
    artifacts = {}
    for target, artifact in TARGETS.items():
        tree = run("cargo", "tree", "--locked", "--manifest-path", str(RUST / "Cargo.toml"),
                   "-p", "butler-agent", "--target", target, "--no-default-features", "--features", "static-ort",
                   "-e", "normal", "--prefix", "none", "--format", "{p}")
        for name, version in re.findall(r"^(\S+) v(\S+)", tree, re.M):
            artifacts.setdefault((name, version), set()).add(artifact)
    packages = [p for p in metadata["packages"] if p["source"] and (p["name"], p["version"]) in artifacts]
    for p in packages:
        files = license_files(Path(p["manifest_path"]).parent)
        repository = (p.get("repository") or "").rstrip("/")
        if files and repository:
            SIBLING_LICENSES.setdefault(repository, [(f"Repository license from {p['name']} {p['version']}/{label}", text)
                                                    for label, text in files])
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        evidence = list(pool.map(crate_evidence, packages))
    missing = [p["name"] for p, _, _, files in evidence if not files]
    if missing:
        raise ValueError(f"Missing source license evidence: {missing}")
    return [record("rust", p["name"], p["version"], license_id, source,
                   sorted(artifacts[(p["name"], p["version"])]), files)
            for p, license_id, source, files in evidence]


def js_components():
    code = "import {productionPackages} from './deploy/licenses/generate.mjs'; console.log(JSON.stringify(productionPackages()));"
    packages = json.loads(run("node", "--input-type=module", "-e", code))
    components = []
    for package in packages:
        name, version = package["identity"].rsplit("@", 1)
        directories = [ROOT / "node_modules" / package["key"]]
        for workspace in ("ui", "electron"):
            directories.append(ROOT / f"packages/butler-app/client/{workspace}/node_modules" / name)
        directories.extend((ROOT / "node_modules/.bun").glob(f"{name.replace('/', '+')}@{version}*/node_modules/{name}"))
        directory = next((p.resolve() for p in directories if (p / "package.json").is_file()
                          and json.loads((p / "package.json").read_text())["version"] == version), None)
        if not directory:
            raise ValueError(f"Install bun.lock first: {name}@{version}")
        manifest = json.loads((directory / "package.json").read_text())
        files = license_files(directory)
        if name == "@hugeicons/core-free-icons" and not files:
            revision = json.loads(fetch("https://api.github.com/repos/hugeicons/hugeicons/commits/main"))["sha"]
            base = f"https://raw.githubusercontent.com/hugeicons/hugeicons/{revision}"
            files = [(f"{base}/LICENSE.md", fetch(f"{base}/LICENSE.md")),
                     (f"{base}/README.md (free icons MIT declaration)", fetch(f"{base}/README.md"))]
        if name.startswith("@radix-ui/") and not files:
            sibling = ROOT / "packages/butler-app/client/ui/node_modules/@radix-ui/react-dialog"
            sibling_version = json.loads((sibling / "package.json").read_text())["version"]
            files = [(f"Radix repository MIT license from react-dialog {sibling_version}/{label}", text)
                     for label, text in license_files(sibling)]
        if name == "react-remove-scroll-bar" and not files:
            revision = "8ca9ba5ea52de03308fe8ced94f7b159a44d28ff"
            url = f"https://raw.githubusercontent.com/theKashey/react-remove-scroll-bar/{revision}/LICENSE"
            files = [(url, fetch(url))]
        if not files:
            raise ValueError(f"Missing npm license evidence: {name} {version}")
        if name == "electron":
            # Runtime includes Node's complete third-party notices in LICENSE.
            files = [("Electron LICENSE", (directory / "LICENSE").read_text())]
        components.append(record("npm", name, version, manifest.get("license"),
                                 f"https://registry.npmjs.org/{name}/-/{name.split('/')[-1]}-{version}.tgz",
                                 ["App/Agent browser renderer" if name != "electron" else "App runtime"],
                                 files, integrity=package["integrity"]))
    return components


def native_components():
    lock = json.loads((RUST / "scripts/static-ort.lock.json").read_text())
    components = []
    for name, repository, license_id in (
        ("onnxruntime", "microsoft/onnxruntime", "MIT"),
        ("onnx", "onnx/onnx", "Apache-2.0"),
    ):
        revision = lock["sources"][name]["commit"]
        base = f"https://raw.githubusercontent.com/{repository}/{revision}"
        files = []
        for file in ("LICENSE", "NOTICE", "ThirdPartyNotices.txt"):
            text = fetch(f"{base}/{file}")
            if text:
                files.append((f"{base}/{file}", text))
        components.append(record("native", name, revision, license_id, base,
                                 list(TARGETS.values()), files))
    revision = lock["sources"]["eigen"]["commit"]
    base = f"https://gitlab.com/libeigen/eigen/-/raw/{revision}"
    files = [(f"{base}/COPYING.MPL2", fetch(f"{base}/COPYING.MPL2"))]
    components.append(record("native", "Eigen", revision, "MPL-2.0", base, list(TARGETS.values()), files))
    metadata = json.loads(run("cargo", "metadata", "--locked", "--format-version", "1", "--manifest-path", str(RUST / "Cargo.toml")))
    package = next(p for p in metadata["packages"] if p["name"] == "libsqlite3-sys")
    sqlite = Path(package["manifest_path"]).parent / "sqlite3/sqlite3.c"
    text = sqlite.read_text()
    version = re.search(r'#define SQLITE_VERSION\s+"([^"]+)"', text).group(1)
    blessing = re.search(r"/\*\n\*\* 2001 September 15.*?\*/", text, re.S).group(0)
    components.append(record("native", "SQLite", version, "blessing", "libsqlite3-sys 0.35.0/sqlite3/sqlite3.c",
                             list(TARGETS.values()), [("SQLite copyright disclaimer and blessing", blessing)]))
    rust_version = tomllib.loads((RUST / "rust-toolchain.toml").read_text())["toolchain"]["channel"]
    base = f"https://raw.githubusercontent.com/rust-lang/rust/{rust_version}"
    files = [(f"{base}/{file}", fetch(f"{base}/{file}")) for file in ("COPYRIGHT", "LICENSE-MIT", "LICENSE-APACHE")]
    components.append(record("native", "Rust standard library", rust_version, "MIT OR Apache-2.0", base,
                             list(TARGETS.values()), files))
    return components


class CreditsParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.capture = None
        self.title = ""
        self.licenses = []
        self.text = ""

    def handle_starttag(self, tag, attrs):
        if tag == "span" and dict(attrs).get("class") == "title":
            self.capture = "title"
            self.title = ""
        if tag == "pre":
            self.capture = "license"
            self.text = ""

    def handle_endtag(self, tag):
        if tag == "span" and self.capture == "title":
            self.capture = None
        if tag == "pre" and self.capture == "license":
            self.licenses.append((self.title, self.text))
            self.capture = None

    def handle_data(self, data):
        if self.capture == "title":
            self.title += data
        if self.capture == "license":
            self.text += data


def runtime_components():
    directory = ROOT / "packages/butler-app/client/electron/node_modules/electron/dist"
    version = json.loads((directory.parent / "package.json").read_text())["version"]
    checksums = json.loads((directory.parent / "checksums.json").read_text())
    files = []
    # Credits vary by platform. Include all three official release runtime lists.
    for target in ("linux-x64", "linux-arm64", "darwin-arm64"):
        archive = f"electron-v{version}-{target}.zip"
        cache = Path(os.environ.get("BUTLER_LICENSE_CACHE", "/tmp/butler-license-runtime"))
        cache.mkdir(exist_ok=True)
        saved = cache / archive
        if not saved.exists():
            url = f"https://github.com/electron/electron/releases/download/v{version}/{archive}"
            with urllib.request.urlopen(url, timeout=60) as response, saved.open("wb") as output:
                while chunk := response.read(1024 * 1024):
                    output.write(chunk)
        with saved.open("rb") as source:
            if hashlib.file_digest(source, "sha256").hexdigest() != checksums[archive]:
                raise ValueError(f"Electron checksum mismatch: {archive}")
        with zipfile.ZipFile(saved) as runtime:
            path = next(name for name in runtime.namelist() if name.endswith("LICENSES.chromium.html"))
            parser = CreditsParser()
            parser.feed(runtime.read(path).decode())
            files += [(f"{target}: {name}", text) for name, text in parser.licenses]
    # Preserve every supplier entry verbatim, including native libraries and Node.
    return [record("runtime", "Electron Chromium Node suppliers", version,
                   "LicenseRef-Electron-ThirdParty", f"Electron {version} LICENSES.chromium.html",
                   ["App runtime"], files)]


def model_components():
    assets = (RUST / "crates/butler-agent/src/host/embedding/worker/assets.rs").read_text()
    revision = re.search(r'const REVISION: &str = "([a-f0-9]+)";', assets).group(1)
    base = f"https://huggingface.co/Xenova/bge-m3/resolve/{revision}"
    license_source = "https://raw.githubusercontent.com/FlagOpen/FlagEmbedding/fd1a2bdf69488ffebe0327999d4400d8c8058a0b/LICENSE"
    return [record("model", "Xenova/bge-m3 (BAAI/bge-m3)", revision, "MIT", base,
                   ["Default embedding model (downloaded, not in archive)"],
                   [("BAAI FlagEmbedding LICENSE", fetch(license_source)),
                    ("Xenova model card (MIT declaration)", fetch(f"{base}/README.md"))])]


def vendored_components():
    entries = [
        ("IBM Plex Mono", "2.5.0", "OFL-1.1", "packages/butler-app/client/ui/src/libs/design-system/fonts/ibm-plex-mono/LICENSE.txt"),
        ("LobeHub provider logos", "1.95.1", "MIT", "packages/butler-app/client/ui/src/libs/design-system/components/ProviderLogo/logos/NOTICE"),
        ("JavaScriptCore V8 Date.parse adaptation", "2026-09-19", "BSD-2-Clause", "packages/butler-agent/rust/crates/butler-core/src/js_date/parse/LICENSE.txt"),
        ("Unicode CLDR timezone names", "ICU 78.1 / TZ 2026c", "Unicode-3.0", "packages/butler-agent/rust/crates/butler-agent/resources/timezones/LICENSE-UNICODE.txt"),
    ]
    return [record("vendored", name, version, license_id, path, list(TARGETS.values()),
                   [(path, (ROOT / path).read_text())]) for name, version, license_id, path in entries]


def main():
    components = rust_components() + js_components() + native_components() + vendored_components() + runtime_components() + model_components()
    code = "import {inputFiles,inputDigest} from './deploy/licenses/inputs.mjs'; console.log(JSON.stringify(Object.fromEntries(inputFiles().map(p=>[p,inputDigest(p)]))));"
    fingerprints = json.loads(run("node", "--input-type=module", "-e", code))
    catalog = dict(inputs=fingerprints,
                   components=sorted(components, key=lambda c: c["id"]))
    (ROOT / "deploy/licenses/catalog.json").write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n")
    print(f"Collected {len(components)} components; run generate.mjs to validate license policy")


if __name__ == "__main__":
    main()
