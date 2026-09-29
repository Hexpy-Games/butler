"""Copy pinned model assets into the ignored local evaluation directory."""

import argparse
import hashlib
import shutil
from pathlib import Path

MODELS = {
    "bge": ("onnx/model_quantized.onnx",
            "0826f8c1ab9edf1801db86c61919d4d108e8bfc0b809ec823ad366882ff0b77d"),
    "e5-small": ("onnx/model_qint8_avx512_vnni.onnx",
                 "dd476dd0c2514e9b9be83aeb3853fac0763e0bdf4a71645407587d77c48a2d88"),
}


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--bge-root", type=Path, required=True)
    parser.add_argument("--e5-root", type=Path, required=True)
    args = parser.parse_args()
    target = Path(__file__).resolve().parent / "models"
    for name, source in (("bge", args.bge_root), ("e5-small", args.e5_root)):
        model, expected = MODELS[name]
        if digest(source / model) != expected:
            raise ValueError(f"{name} model hash mismatch")
        destination = target / name
        destination.mkdir(parents=True, exist_ok=True)
        for file in ("tokenizer.json", "config.json", "tokenizer_config.json", model):
            target_file = destination / file
            target_file.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source / file, target_file)
        if digest(destination / model) != expected:
            raise ValueError(f"{name} copied model hash mismatch")
        print(f"{name}: verified")


if __name__ == "__main__":
    main()
