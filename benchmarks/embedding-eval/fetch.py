"""Fetch pinned, ungated ONNX assets into the ignored local models directory."""

import hashlib
from pathlib import Path

from huggingface_hub import hf_hub_download

ROOT = Path(__file__).resolve().parent / "models"
MODELS = {
    "bge": ("Xenova/bge-m3", "4de13258303883538bd53b696b452bf8099f0858", "onnx/model_quantized.onnx"),
    "e5-small": ("intfloat/multilingual-e5-small", "614241f622f53c4eeff9890bdc4f31cfecc418b3", "onnx/model_qint8_avx512_vnni.onnx"),
    "e5-base": ("intfloat/multilingual-e5-base", "d128750597153bb5987e10b1c3493a34e5a4502a", "onnx/model_qint8_avx512_vnni.onnx"),
    "snowflake": ("Snowflake/snowflake-arctic-embed-m-v2.0", "95c2741480856aa9666782eb4afe11959938017f", "onnx/model_int8.onnx"),
    # This official repository PR contains the public ONNX export; main does not.
    "gte": ("Alibaba-NLP/gte-multilingual-base", "a3dc39eb01581850e5115626349f6dfca99f0438", "onnx/model.onnx"),
}
ONNX_SHA256 = {
    "bge": "0826f8c1ab9edf1801db86c61919d4d108e8bfc0b809ec823ad366882ff0b77d",
    "e5-small": "dd476dd0c2514e9b9be83aeb3853fac0763e0bdf4a71645407587d77c48a2d88",
    "e5-base": "2523551878658b305550d8759443822dbfda9ed9c8012ef2c354ba2c5b9de503",
    "snowflake": "03d923bb1850ebdccb068e2f3abd8aa43fe81c50d07d037ef103fe3d0fb78e3b",
    "gte": "2101e2554e1ebb4f96f09384eb272e74e18c5aad4474fa3919777f5172097385",
}
GTE_DYNAMIC_SHA256 = "fc37af08e093b4970d97fa1772e8b9f7c12b5324e2783f27da34bc227dfc2141"


def check_hash(path, expected):
    with path.open("rb") as source:
        digest = hashlib.file_digest(source, "sha256").hexdigest()
    if digest != expected:
        raise RuntimeError(f"SHA-256 mismatch for {path}")


def main():
    for name, (repo, revision, onnx) in MODELS.items():
        for file in ["config.json", "tokenizer.json", "tokenizer_config.json", onnx]:
            path = hf_hub_download(repo, file, revision=revision, local_dir=ROOT / name)
            print(name, file, Path(path).stat().st_size, flush=True)
        check_hash(ROOT / name / onnx, ONNX_SHA256[name])
    from onnxruntime.quantization import QuantType, quantize_dynamic

    source = ROOT / "gte" / "onnx" / "model.onnx"
    dest = source.with_name("model_dynamic_int8.onnx")
    if not dest.exists():
        quantize_dynamic(str(source), str(dest), weight_type=QuantType.QInt8)
    check_hash(dest, GTE_DYNAMIC_SHA256)
    print("gte", dest.name, dest.stat().st_size)


if __name__ == "__main__":
    main()
