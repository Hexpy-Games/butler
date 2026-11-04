"""One measured run of a packaged spike variant.
usage: python3 -I run.py <variant> <scenario> [--perf] [--label <name>] [--extra "<app args>"]
scenario: blank | orig | chat | tab1 | artifact | hidden   (hidden = orig page, then the app is hidden before measuring)
--extra passes app flags (e.g. "--zero-copy", "--tabs 4"); with --tabs N the run waits for the N-1 background tabs first.
--perf runs the app's own --measure harness (--modes overrides "idle,animate"). --cpu (with --perf --modes idle) also samples
CPU time (ps) and wakeups (proc_pid_rusage) per process for 15 s, 40-55 s after launch, inside the harness's
static idle settle, into raw/cpu.jsonl.
scenario delayed: a static page that changes its text after 15 s and logs the time to its next animation frame.
Footprint per process via measure.py (footprint, never RSS): 30 s settle, 3 readings 10 s apart, median."""
import os, shutil, signal, subprocess, sys, tempfile, time
B = "/tmp/cef-osr-memory"; ROOT = f"{B}/src"; STUDY = os.path.expanduser("~/tmp/mem-study-20261103")
variant, scenario = sys.argv[1], sys.argv[2]; perf = "--perf" in sys.argv; cpu = "--cpu" in sys.argv
opt = lambda name: sys.argv[sys.argv.index(name) + 1] if name in sys.argv else None
extra = (opt("--extra") or "").split(); name = opt("--label") or variant
tabs = int(extra[extra.index("--tabs") + 1]) if "--tabs" in extra else 1
APP = f"{B}/apps/{variant}/ButlerCefSpike.app"
content = {
    "orig": open(f"{B}/content/orig.html").read(), "hidden": open(f"{B}/content/orig.html").read(),
    "blank": "<!doctype html><html><head><meta charset=utf-8><title>blank</title></head><body></body></html>",
    "chat": open(f"{STUDY}/content/chat.html").read(), "artifact": open(f"{STUDY}/content/artifact.html").read(),
    "delayed": open(f"{B}/content/delayed.html").read(),
    "tab1": '<!doctype html><meta http-equiv="refresh" content="0;url=https://en.wikipedia.org/wiki/Web_browser">',
}[scenario]
open(f"{ROOT}/src/fixture.html", "w").write(content)
os.makedirs(f"{ROOT}/memory-evidence", exist_ok=True); os.makedirs(f"{B}/raw/detail", exist_ok=True)
env = dict(os.environ, MallocNanoZone="0", OS_ACTIVITY_MODE="disable")
for k in ("HOME", "BUTLER_DATA", "TMPDIR"):
    env[k] = tempfile.mkdtemp(prefix=f"{k.lower()}-", dir=f"{B}/scratch")
shutil.rmtree(f"{ROOT}/profile-pool", ignore_errors=True); os.makedirs(f"{ROOT}/profile-pool")
label = f"{name}/{scenario}" + ("/perf" if perf else "")
log = f"{ROOT}/memory-evidence/{name}-{scenario}{'-perf' if perf else ''}.jsonl"
if os.path.exists(log): os.remove(log)
args = ["--log", log, *extra]
if perf: args += ["--measure", "--modes", opt("--modes") or "idle,animate"]
scale = lambda: subprocess.run([f"{STUDY}/src/scale"], capture_output=True, text=True).stdout.strip()
s0 = scale()
app = subprocess.Popen([f"{APP}/Contents/MacOS/ButlerCefSpike-bin", *args, "--pump-max-ms", "33", "--use-mock-keychain",
                        "--password-store=basic", "--disable-crash-reporter", "--disable-breakpad", "--disable-component-update"],
                       env=env, stdout=open(f"{B}/raw/{name}-{scenario}.out", "w"), stderr=subprocess.STDOUT,
                       stdin=subprocess.DEVNULL, start_new_session=True)
try:
    if perf:
        if cpu:
            # The harness keeps the page idle for 60 s after first paint; sample 15 s inside that.
            time.sleep(40)
            import ctypes, json
            libc = ctypes.CDLL(None)
            def usage(p):  # rusage_info_v2 prefix: uuid[16], user, system, pkg_idle_wkups, interrupt_wkups
                buf = (ctypes.c_uint64 * 32)()
                if libc.proc_pid_rusage(int(p), 2, ctypes.byref(buf)) != 0: return None
                return buf[4], buf[5]
            pids = subprocess.run(["pgrep", "-g", str(app.pid)], capture_output=True, text=True).stdout.split()
            cputime = lambda: {p: subprocess.run(["ps", "-o", "time=", "-p", p], capture_output=True, text=True).stdout.strip() for p in pids}
            secs = lambda t: sum(float(x) * 60 ** i for i, x in enumerate(reversed(t.replace("-", ":").split(":")))) if t else None
            before, wb = cputime(), {p: usage(p) for p in pids}
            time.sleep(15)
            after, wa = cputime(), {p: usage(p) for p in pids}
            rows = []
            for p in pids:
                cmd = subprocess.run(["ps", "-o", "command=", "-p", p], capture_output=True, text=True).stdout.strip()
                role = cmd.split("--type=")[1].split()[0] if "--type=" in cmd else "main"
                b, a = secs(before.get(p)), secs(after.get(p))
                if b is None or a is None or not wb.get(p) or not wa.get(p): continue
                rows.append({"pid": p, "role": role, "cpu_pct": round((a - b) / 15 * 100, 2),
                             "idle_wakeups_per_s": round((wa[p][0] - wb[p][0]) / 15, 1), "interrupt_wakeups_per_s": round((wa[p][1] - wb[p][1]) / 15, 1)})
            open(f"{B}/raw/cpu.jsonl", "a").write(json.dumps({"label": label, "processes": rows, "cpu_pct": round(sum(r["cpu_pct"] for r in rows), 2),
                "idle_wakeups_per_s": round(sum(r["idle_wakeups_per_s"] for r in rows), 1), "interrupt_wakeups_per_s": round(sum(r["interrupt_wakeups_per_s"] for r in rows), 1)}) + "\n")
        app.wait(timeout=240)  # --measure runs its modes, logs metric events, then quits
    else:
        time.sleep(3)
        deadline = time.time() + 180
        while tabs > 1 and open(log).read().count('"background_tab"') < tabs - 1:
            assert time.time() < deadline and app.poll() is None, "background tabs did not open"
            time.sleep(1)
        if scenario == "hidden":
            time.sleep(10); subprocess.run([f"{B}/hide", str(app.pid)], check=True)
        subprocess.run(["python3", "-I", f"{STUDY}/src/measure.py", label, str(app.pid), "--out", f"{B}/raw/runs.jsonl"], check=False)
        out = f"{B}/raw/detail/{name}-{scenario}"; os.makedirs(out, exist_ok=True)
        for p in subprocess.run(["pgrep", "-g", str(app.pid)], capture_output=True, text=True).stdout.split():
            cmd = subprocess.run(["ps", "-o", "command=", "-p", p], capture_output=True, text=True).stdout.strip()
            fp = subprocess.run(["footprint", "-p", p], capture_output=True, text=True).stdout
            vm = subprocess.run(["vmmap", "-w", p], capture_output=True, text=True).stdout
            sel = [l for l in vm.splitlines() if l.startswith(("IOSurface", "IOAccelerator", "CoreAnimation")) or (l.startswith(("__DATA_CONST", "__DATA ")) and "Embedded" in l)]
            open(f"{out}/{p}.txt", "w").write(cmd + "\n\n" + fp + "\n\n" + "\n".join(sel) + "\n")
        if scenario != "hidden":
            wid = subprocess.run([f"{B}/window-id", str(app.pid)], capture_output=True, text=True).stdout.strip()
            if wid: subprocess.run(["screencapture", "-x", "-o", "-l", wid, f"{B}/raw/shot-{name}-{scenario}.png"])
finally:
    open(f"{B}/raw/scale.log", "a").write(f"{label} before={s0!r} after={scale()!r}\n")
    try:
        os.killpg(app.pid, signal.SIGTERM); time.sleep(4); os.killpg(app.pid, signal.SIGKILL)
    except OSError:
        pass
    for k in ("HOME", "BUTLER_DATA", "TMPDIR"): shutil.rmtree(env[k], ignore_errors=True)
