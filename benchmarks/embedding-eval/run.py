"""Run isolated release Rust/ORT arms and sample macOS physical footprint.

The footprint inspection is benchmark-only and does not enter product code.
"""

import argparse
import itertools
import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
MODELS = {
    "bge": ("model_quantized.onnx", 8192, "cls", "", ""),
    "e5-small": ("model_qint8_avx512_vnni.onnx", 512, "mean", "query: ", "passage: "),
    "e5-base": ("model_qint8_avx512_vnni.onnx", 512, "mean", "query: ", "passage: "),
    "snowflake": ("model_int8.onnx", 8192, "cls", "query: ", ""),
    "gte": ("model_dynamic_int8.onnx", 8192, "cls", "", ""),
}


def footprint(pid):
    result = subprocess.run(["footprint", "-f", "bytes", "--noCategories", "-p", str(pid)],
                            capture_output=True, text=True, check=True)
    values = {}
    for line in result.stdout.splitlines():
        if line.strip().startswith("phys_footprint:"):
            values["physical_bytes"] = int(line.split(":", 1)[1].strip().split()[0])
        elif line.strip().startswith("phys_footprint_peak:"):
            values["peak_bytes"] = int(line.split(":", 1)[1].strip().split()[0])
    if set(values) != {"physical_bytes", "peak_bytes"}:
        raise RuntimeError("footprint did not report both physical footprint fields")
    return values


def run_arm(binary, config):
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", dir=ROOT, delete=True) as setting:
        json.dump(config, setting)
        setting.flush()
        proc = subprocess.Popen([str(binary), setting.name], stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            phase = proc.stdout.readline().strip()
            if phase != "LOADED":
                raise RuntimeError(f"load failed: {phase}; {proc.stderr.read()[-1000:]}")
            idle = footprint(proc.pid)
            proc.stdin.write("\n")
            proc.stdin.flush()
            summary_line = proc.stdout.readline()
            if not summary_line:
                raise RuntimeError(f"inference failed: {proc.stderr.read()[-1000:]}")
            summary = json.loads(summary_line)
            after = footprint(proc.pid)
            proc.stdin.write("\n")
            proc.stdin.flush()
            proc.communicate(timeout=10)
            if proc.returncode:
                raise RuntimeError(f"worker exited {proc.returncode}")
            return {"config": config, "idle": idle, "after": after, "summary": summary}
        finally:
            if proc.poll() is None:
                proc.terminate()
                proc.communicate(timeout=10)


def config_for(name, dataset, **settings):
    filename, limit, pool, query, document = MODELS[name]
    root = ROOT / "models" / name
    config = {
        "model": str(root / "onnx" / filename), "tokenizer": str(root / "tokenizer.json"),
        "dataset": str(dataset), "max_tokens": limit, "pool": pool,
        "query_prefix": query, "document_prefix": document,
        "optimization": "all", "prepacking": True, "cpu_arena": True,
        "memory_pattern": True, "threads": 1, "env_allocators": False,
    }
    config.update(settings)
    return config


def matrix_configs(dataset):
    yield "product-defaults", config_for("bge", dataset, product_defaults=True)
    for level, prepack, arena, pattern, threads, env in itertools.product(
        ["disable", "basic", "extended", "all"], [False, True], [False, True],
        [False, True], [1, 4], [False, True]
    ):
        name = (f"opt-{level}_prepack-{int(prepack)}_arena-{int(arena)}_"
                f"pattern-{int(pattern)}_threads-{threads}_env-{int(env)}")
        yield name, config_for("bge", dataset, optimization=level, prepacking=prepack,
                               cpu_arena=arena, memory_pattern=pattern, threads=threads,
                               env_allocators=env)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["matrix", "models"])
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--dataset", type=Path, default=ROOT / "dataset.json")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--only", nargs="*", default=[])
    args = parser.parse_args()
    if sys.platform != "darwin":
        raise SystemExit("physical footprint measurement requires macOS footprint")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    done = set()
    if args.output.exists():
        for line in args.output.read_text().splitlines():
            done.add(json.loads(line)["arm"])
    if args.mode == "matrix":
        tiny = json.loads(args.dataset.read_text())
        tiny["documents"] = tiny["documents"][:1]
        tiny["queries"] = tiny["queries"][:1]
        path = ROOT / "results" / "tiny.json"
        path.parent.mkdir(exist_ok=True)
        path.write_text(json.dumps(tiny))
        arms = matrix_configs(path)
    else:
        arms = [(name, config_for(name, args.dataset, cpu_arena=False, threads=4)) for name in MODELS]
        arms.append(("bge-lowmem", config_for("bge", args.dataset, optimization="all",
                                               prepacking=False, cpu_arena=True,
                                               memory_pattern=False, threads=1)))
    with args.output.open("a") as out:
        for arm, config in arms:
            if arm in done or (args.only and arm not in args.only) or not Path(config["model"]).is_file():
                continue
            print(f"running {arm}", flush=True)
            try:
                result = run_arm(args.binary, config)
                result["arm"] = arm
            except Exception as exc:
                result = {"arm": arm, "config": config, "error": str(exc)}
            out.write(json.dumps(result, ensure_ascii=False) + "\n")
            out.flush()
            print("ok" if "error" not in result else result["error"], flush=True)


if __name__ == "__main__":
    main()
