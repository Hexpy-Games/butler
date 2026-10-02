"""Expand the losslessly deduplicated evidence archive to newline-delimited JSON."""
import gzip
import json
import sys

with gzip.open(sys.argv[1], "rt", encoding="utf-8") as source:
    archive = json.load(source)
assert archive["format"] == "butler.behavior-evidence.v1"
objects = archive["objects"]
for row in archive["observations"]:
    row["requests"] = [
        dict({key: objects[ref] for key, ref in request["fields"].items()},
             input=[objects[ref] for ref in request["input"]])
        for request in row["requests"]
    ]
    print(json.dumps(row, ensure_ascii=False))
