#!/usr/bin/env python3
"""Replay captured Anthropic Messages requests in prompt variants.

Input directory:
  cases/<case>.request.json   Messages API bodies, without credentials
  variants.json               {"<variant>": [edit, ...], ...}
    edit: {"replace": "<exact text>", "with": "<text>"}
          {"insert_after": "<exact text>", "text": "<text>"}
    Each edit applies to every string in the request and must match at least once.

Writes <out>/<case>/<variant>/<run>.json with the full response, and prints
only content-free metrics, because workflow logs may be public.
"""
import argparse
import json
import os
import pathlib
import sys
import time
import urllib.error
import urllib.request

API = "https://api.anthropic.com/v1/messages"


def apply(value, edit, hits):
    if isinstance(value, str):
        if "replace" in edit and edit["replace"] in value:
            hits[0] += 1
            return value.replace(edit["replace"], edit["with"])
        if "insert_after" in edit and edit["insert_after"] in value:
            hits[0] += 1
            anchor = edit["insert_after"]
            return value.replace(anchor, anchor + edit["text"])
        return value
    if isinstance(value, list):
        return [apply(item, edit, hits) for item in value]
    if isinstance(value, dict):
        return {key: apply(item, edit, hits) for key, item in value.items()}
    return value


def variant_body(body, edits, case, variant):
    for index, edit in enumerate(edits):
        hits = [0]
        body = apply(body, edit, hits)
        if hits[0] == 0:
            sys.exit(f"{case}/{variant}: edit {index} matched nothing")
    return body


def send(body, key):
    # Captured bodies may ask for SSE; this runner reads one JSON response.
    data = json.dumps({**body, "stream": False}).encode()
    for attempt in range(6):
        request = urllib.request.Request(API, data=data, method="POST", headers={
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        })
        try:
            with urllib.request.urlopen(request, timeout=600) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            if error.code in (429, 500, 502, 503, 529) and attempt < 5:
                time.sleep(2 ** attempt * 5)
                continue
            # Print only the error type: an error body may quote request values.
            try:
                kind = json.loads(error.read()).get("error", {}).get("type")
            except ValueError:
                kind = None
            sys.exit(f"HTTP {error.code}: {kind}")
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            if attempt < 5:
                time.sleep(2 ** attempt * 5)
                continue
            raise
    sys.exit("retries exhausted")


def metrics(response):
    tools = [part.get("name") for part in response.get("content", []) if part.get("type") == "tool_use"]
    text = sum(len(part.get("text", "")) for part in response.get("content", []) if part.get("type") == "text")
    usage = response.get("usage", {})
    return {
        "stop": response.get("stop_reason"),
        "tools": tools,
        "text_chars": text,
        "input": usage.get("input_tokens"),
        "cache_read": usage.get("cache_read_input_tokens"),
        "cache_write": usage.get("cache_creation_input_tokens"),
        "output": usage.get("output_tokens"),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("bundle", type=pathlib.Path)
    parser.add_argument("out", type=pathlib.Path)
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--dry-run", action="store_true", help="apply edits only; no requests")
    args = parser.parse_args()
    key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not key and not args.dry_run:
        sys.exit("ANTHROPIC_API_KEY is not set")
    variants = json.loads((args.bundle / "variants.json").read_text())
    cases = sorted((args.bundle / "cases").glob("*.request.json"))
    summary = []
    for path in cases:
        case = path.name.removesuffix(".request.json")
        base = json.loads(path.read_text())
        for variant, edits in variants.items():
            body = variant_body(base, edits, case, variant)
            if args.dry_run:
                print(f"{case}\t{variant}\tok")
                continue
            for run in range(1, args.repeats + 1):
                response = send(body, key)
                target = args.out / case / variant / f"{run}.json"
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(json.dumps(response, ensure_ascii=False, indent=1))
                row = {"case": case, "variant": variant, "run": run, **metrics(response)}
                summary.append(row)
                print(json.dumps(row))
    if not args.dry_run:
        (args.out / "summary.json").write_text(json.dumps(summary, indent=1))


if __name__ == "__main__":
    main()
