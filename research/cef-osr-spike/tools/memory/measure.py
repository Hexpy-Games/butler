"""Per-process physical footprint of an app's process tree plus XPC services it is responsible for.

usage: python3 -I measure.py <label> <root-pid> [--readings 3] [--interval 10] [--settle 30] [--out raw.jsonl]
Footprint = `footprint -f bytes --noCategories` ("phys_footprint"), never RSS.
"""
import ctypes, json, re, statistics, subprocess, sys, time

lib = ctypes.CDLL(None)
_resp = lib.responsibility_get_pid_responsible_for_pid
_resp.restype = ctypes.c_int
_resp.argtypes = [ctypes.c_int]


def procs():
    out = subprocess.run(["ps", "-axww", "-o", "pid=,ppid=,rss=,command="], capture_output=True, text=True).stdout
    rows = {}
    for line in out.splitlines():
        m = re.match(r"\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)", line)
        if m:
            rows[int(m[1])] = (int(m[2]), m[4], int(m[3]))
    return rows


def tree(root, rows):
    keep = {root}
    for pid in rows:
        if pid != root and _resp(pid) == root:
            keep.add(pid)
    changed = True
    while changed:
        changed = False
        for pid, (ppid, *_) in rows.items():
            if ppid in keep and pid not in keep:
                keep.add(pid); changed = True
    return sorted(p for p in keep if p in rows)


def role(cmd, root_cmd):
    c = cmd
    if "com.apple.WebKit.WebContent" in c: return "wk-webcontent"
    if "com.apple.WebKit.Networking" in c: return "wk-networking"
    if "com.apple.WebKit.GPU" in c: return "wk-gpu"
    if "butler-agent" in c and "--type=" not in c: return "butler-agent"
    if "--type=renderer" in c: return "renderer"
    if "--type=gpu-process" in c: return "gpu"
    if "--type=utility" in c and "network.mojom.NetworkService" in c: return "network"
    if "--type=utility" in c: return "utility-other"
    if "crashpad" in c.lower(): return "crashpad"
    if c == root_cmd: return "main"
    if "MTLCompilerService" in c: return "xpc-mtl-compiler"
    if "XPCServices" in c: return "xpc-other"
    return "other"


def footprints(pids):
    args = ["footprint", "-f", "bytes", "--noCategories"]
    for p in pids:
        args += ["-p", str(p)]
    out = subprocess.run(args, capture_output=True, text=True).stdout
    res = {}
    for m in re.finditer(r"\[(\d+)\]:.*?Footprint:\s*(\d+)\s*B", out):
        res[int(m[1])] = int(m[2])
    return res


def reading(root):
    rows = procs()
    pids = tree(root, rows)
    fp = footprints(pids)
    root_cmd = rows[root][1]
    items = []
    for p in pids:
        if p in fp:
            items.append({"pid": p, "role": role(rows[p][1], root_cmd), "bytes": fp[p], "rss_kb": rows[p][2], "cmd": rows[p][1][:300]})
    return items


def summarize(items):
    roles = {}
    for it in items:
        r = roles.setdefault(it["role"], {"n": 0, "bytes": 0})
        r["n"] += 1; r["bytes"] += it["bytes"]
    total = sum(it["bytes"] for it in items)
    ui_total = sum(it["bytes"] for it in items if it["role"] != "butler-agent")
    return {"roles": roles, "total": total, "total_excl_agent": ui_total, "rss_sum": sum(it["rss_kb"] for it in items) * 1024}


def main():
    a = sys.argv[1:]
    label, root = a[0], int(a[1])
    opt = {"--readings": 3, "--interval": 10, "--settle": 30, "--out": None}
    i = 2
    while i < len(a):
        opt[a[i]] = a[i + 1] if a[i] == "--out" else int(a[i + 1]); i += 2
    time.sleep(opt["--settle"])
    reads = []
    for k in range(opt["--readings"]):
        if k: time.sleep(opt["--interval"])
        items = reading(root)
        reads.append({"t": time.time(), "items": items, **summarize(items)})
    MiB = 1024 * 1024
    allroles = sorted({r for rd in reads for r in rd["roles"]})
    med = {r: statistics.median(rd["roles"].get(r, {"bytes": 0})["bytes"] for rd in reads) / MiB for r in allroles}
    cnt = {r: max(rd["roles"].get(r, {"n": 0})["n"] for rd in reads) for r in allroles}
    rec = {"label": label, "root": root, "median_MiB": {r: round(v, 1) for r, v in med.items()}, "count": cnt,
           "total_MiB": round(statistics.median(rd["total"] for rd in reads) / MiB, 1),
           "total_excl_agent_MiB": round(statistics.median(rd["total_excl_agent"] for rd in reads) / MiB, 1),
           "readings_total_MiB": [round(rd["total"] / MiB, 1) for rd in reads], "rss_sum_MiB": [round(rd["rss_sum"] / MiB, 1) for rd in reads], "readings": reads}
    if opt["--out"]:
        with open(opt["--out"], "a") as f: f.write(json.dumps(rec) + "\n")
    short = {k: v for k, v in rec.items() if k != "readings"}
    print(json.dumps(short))
    for it in reads[-1]["items"]:
        print(f'  {it["pid"]:>6} {it["role"]:<15} {it["bytes"]/MiB:8.1f} MiB  {it["cmd"][:110]}')


main()
