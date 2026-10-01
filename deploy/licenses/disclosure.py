"""Turn reviewed evidence into link-only distribution disclosures."""
import json
import os
import re
from pathlib import Path

HOMEPAGES = {
    "SQLite": "https://www.sqlite.org/copyright.html",
    "IBM Plex Mono": "https://github.com/IBM/plex/blob/2f9ba1b25957d958db71a849e85d72e3ecfb845a/LICENSE.txt",
    "LobeHub provider logos": "https://github.com/lobehub/lobe-icons/blob/49a2130df7bfa5eb1b088261bff20a37e2967789/LICENSE",
    "JavaScriptCore V8 Date.parse adaptation": "https://v8.dev/",
    "Unicode CLDR timezone names": "https://github.com/unicode-org/icu/blob/release-78.1/LICENSE",
}


def license_links(component):
    kind = component["id"].split(":", 1)[0]
    name, version = component["name"], component["version"]
    explicit = [label.split(" ")[0] for label in component["files"]
                if label.startswith("https://") and re.search(r"(?:LICENSE|COPYING|NOTICE|license/)", label, re.I)]
    explicit = [link.replace("/tree/", "/blob/") if link.startswith("https://github.com/") else link for link in explicit]
    if explicit and kind != "rust":
        return list(dict.fromkeys(explicit))
    if kind == "rust":
        # Cargo records the repository commit and package subdirectory. Only
        # local files mapped by that metadata can be resolved without guessing.
        cache = Path(os.environ.get("CARGO_HOME", Path.home() / ".cargo")) / "registry/src"
        for directory in cache.glob(f"*/{name}-{version}"):
            vcs = directory / ".cargo_vcs_info.json"
            if not vcs.is_file() or "/tree/" not in component["source"]:
                continue
            prefix = json.loads(vcs.read_text()).get("path_in_vcs", "")
            links = [component["source"].replace("/tree/", "/blob/") + "/"
                     + "/".join(part for part in (prefix, label) if part)
                     for label in component["files"] if (directory / label).is_file()]
            if links:
                return list(dict.fromkeys(explicit + links))
        if explicit:
            return list(dict.fromkeys(explicit))
        return [f"https://crates.io/crates/{name}/{version}"]
    if kind == "npm":
        if name == "electron":
            return [f"https://github.com/electron/electron/blob/v{version}/LICENSE"]
        return [f"https://www.npmjs.com/package/{name}/v/{version}"]
    if kind == "runtime":
        return [f"https://github.com/electron/electron/releases/tag/v{version}"]
    if kind == "model":
        return ["https://github.com/FlagOpen/FlagEmbedding/blob/fd1a2bdf69488ffebe0327999d4400d8c8058a0b/LICENSE",
                component["source"] + "/README.md"]
    return [HOMEPAGES[name]]


def copyrights(texts):
    lines = []
    for text in texts:
        source = text.splitlines()
        for index, line in enumerate(source):
            # Retain attribution, not generic license conditions referring to
            # a copyright notice. Ignore unfilled license-template examples.
            clean = line.strip().lstrip("#* ").strip()
            named = re.match(r"^Copyright\s+(?!Holder|Notice|Owner|Law|Statement|Assignment)(?:[A-Z][a-z]|JS\b|https?:|jQuery)", clean)
            if not named and not re.search(r"(?:copyright.*(?:\d{4}|\(c\)|©)|©.*\d{4})", line, re.I):
                continue
            if "[yyyy]" in line or "[name of copyright owner]" in line:
                continue
            lines.append(line.strip())
            # Wrapped author lists and addresses belong to the attribution.
            # Stop before legal conditions; never append a license body.
            tail = line.strip()
            for following in source[index + 1:]:
                value = following.strip().lstrip("#* ").strip()
                if not value or not re.search(r"(?:,|\bby|\(c\)|\d{4})$", tail, re.I):
                    break
                if re.match(r"(?:Permission|Redistribution|Licensed|This|All rights|THE |the software|except|specified|is |are |may |under )", value):
                    break
                lines.append(following.strip())
                tail = value
    return list(dict.fromkeys(lines))


def disclose(component, texts):
    component["links"] = license_links(component)
    component["copyright"] = copyrights(texts)
    return component
