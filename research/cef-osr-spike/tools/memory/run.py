"""One measured run of a packaged spike variant.
usage: python3 -I run.py <variant> <scenario> [--perf]
scenario: blank | orig | chat | tab1 | artifact | hidden   (hidden = orig page, then the app is hidden before measuring)
Footprint per process via measure.py (footprint, never RSS): 30 s settle, 3 readings 10 s apart, median."""
import os, shutil, signal, subprocess, sys, tempfile, time
B = "/tmp/cef-osr-memory"; ROOT = f"{B}/src"; STUDY = os.path.expanduser("~/tmp/mem-study-20261103")
variant, scenario = sys.argv[1], sys.argv[2]; perf = "--perf" in sys.argv
APP = f"{B}/apps/{variant}/ButlerCefSpike.app"
content = {
    "orig": open(f"{B}/content/orig.html").read(), "hidden": open(f"{B}/content/orig.html").read(),
    "blank": "<!doctype html><html><head><meta charset=utf-8><title>blank</title></head><body></body></html>",
    "chat": open(f"{STUDY}/content/chat.html").read(), "artifact": open(f"{STUDY}/content/artifact.html").read(),
    "tab1": '<!doctype html><meta http-equiv="refresh" content="0;url=https://en.wikipedia.org/wiki/Web_browser">',
}[scenario]
open(f"{ROOT}/src/fixture.html", "w").write(content)
os.makedirs(f"{ROOT}/memory-evidence", exist_ok=True); os.makedirs(f"{B}/raw/detail", exist_ok=True)
env = dict(os.environ, MallocNanoZone="0", OS_ACTIVITY_MODE="disable")
for k in ("HOME", "BUTLER_DATA", "TMPDIR"):
    env[k] = tempfile.mkdtemp(prefix=f"{k.lower()}-", dir=f"{B}/scratch")
shutil.rmtree(f"{ROOT}/profile-pool", ignore_errors=True); os.makedirs(f"{ROOT}/profile-pool")
label = f"{variant}/{scenario}" + ("/perf" if perf else "")
args = ["--log", f"{ROOT}/memory-evidence/{variant}-{scenario}{'-perf' if perf else ''}.jsonl"]
if perf: args += ["--measure", "--modes", "idle,animate"]
scale = lambda: subprocess.run([f"{STUDY}/src/scale"], capture_output=True, text=True).stdout.strip()
s0 = scale()
app = subprocess.Popen([f"{APP}/Contents/MacOS/ButlerCefSpike-bin", *args, "--pump-max-ms", "33", "--use-mock-keychain",
                        "--password-store=basic", "--disable-crash-reporter", "--disable-breakpad", "--disable-component-update"],
                       env=env, stdout=open(f"{B}/raw/{variant}-{scenario}.out", "w"), stderr=subprocess.STDOUT,
                       stdin=subprocess.DEVNULL, start_new_session=True)
try:
    if perf:
        app.wait(timeout=240)  # --measure runs its modes, logs metric events, then quits
    else:
        time.sleep(3)
        if scenario == "hidden":
            time.sleep(10); subprocess.run([f"{B}/hide", str(app.pid)], check=True)
        subprocess.run(["python3", "-I", f"{STUDY}/src/measure.py", label, str(app.pid), "--out", f"{B}/raw/runs.jsonl"], check=False)
        out = f"{B}/raw/detail/{variant}-{scenario}"; os.makedirs(out, exist_ok=True)
        for p in subprocess.run(["pgrep", "-g", str(app.pid)], capture_output=True, text=True).stdout.split():
            cmd = subprocess.run(["ps", "-o", "command=", "-p", p], capture_output=True, text=True).stdout.strip()
            fp = subprocess.run(["footprint", "-p", p], capture_output=True, text=True).stdout
            vm = subprocess.run(["vmmap", "-w", p], capture_output=True, text=True).stdout
            sel = [l for l in vm.splitlines() if l.startswith(("IOSurface", "IOAccelerator", "CoreAnimation")) or (l.startswith(("__DATA_CONST", "__DATA ")) and "Embedded" in l)]
            open(f"{out}/{p}.txt", "w").write(cmd + "\n\n" + fp + "\n\n" + "\n".join(sel) + "\n")
        if scenario in ("blank", "orig", "chat"):
            wid = subprocess.run([f"{B}/window-id", str(app.pid)], capture_output=True, text=True).stdout.strip()
            if wid: subprocess.run(["screencapture", "-x", "-o", "-l", wid, f"{B}/raw/shot-{variant}-{scenario}.png"])
finally:
    open(f"{B}/raw/scale.log", "a").write(f"{label} before={s0!r} after={scale()!r}\n")
    try:
        os.killpg(app.pid, signal.SIGTERM); time.sleep(4); os.killpg(app.pid, signal.SIGKILL)
    except OSError:
        pass
    for k in ("HOME", "BUTLER_DATA", "TMPDIR"): shutil.rmtree(env[k], ignore_errors=True)
