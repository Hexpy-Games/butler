#!/usr/bin/env python3
"""Verify the same pinned four embedding fixtures as hosted E2E CI."""
import hashlib
import os
from pathlib import Path
import urllib.request

revision = "4de13258303883538bd53b696b452bf8099f0858"
root = Path(os.environ["CARGO_TARGET_DIR"]) / "e2e-models" / revision
files = {
    "tokenizer.json": "6710678b12670bc442b99edc952c4d996ae309a7020c1fa0096dd245c2faf790",
    "tokenizer_config.json": "7e4c1cc848840aeccdd763458c18dd525eb0f795c992e00ebe9c28554e7db2d4",
    "config.json": "734a79bf12d388c1467a4e3ab625f45de7f6906cffcfb93a1eca1787504bed95",
    "onnx/model_quantized.onnx": "0826f8c1ab9edf1801db86c61919d4d108e8bfc0b809ec823ad366882ff0b77d",
}
for name, expected in files.items():
    path = root / name
    if path.is_file():
        with path.open("rb") as file:
            valid = hashlib.file_digest(file, "sha256").hexdigest() == expected
        if valid:
            continue
    path.parent.mkdir(parents=True, exist_ok=True)
    staged = path.with_suffix(path.suffix + ".download")
    try:
        urllib.request.urlretrieve(f"https://huggingface.co/Xenova/bge-m3/resolve/{revision}/{name}", staged)
        with staged.open("rb") as file:
            assert hashlib.file_digest(file, "sha256").hexdigest() == expected, name
        staged.replace(path)
    finally:
        staged.unlink(missing_ok=True)
print(f"Verified pinned embedding fixtures: {revision}")
with open(os.environ["GITHUB_ENV"], "a", encoding="utf-8") as file:
    file.write(f"BUTLER_E2E_EMBEDDING_ASSETS={root}\n")
