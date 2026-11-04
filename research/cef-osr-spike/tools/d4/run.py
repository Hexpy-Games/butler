"""Run the D4 research harness and acknowledge requested full-screen captures."""
import json
import math
import os
import signal
import pathlib
import subprocess
import sys
import time


def capture_rect(rects, margin_x, margin_y, dest):
    x = max(0, math.floor(min(r['x'] for r in rects) - margin_x))
    y = max(0, math.floor(min(r['y'] for r in rects) - margin_y))
    right = math.ceil(max(r['x'] + r['width'] for r in rects) + margin_x)
    bottom = math.ceil(max(r['y'] + r['height'] for r in rects) + margin_y)
    png = dest.with_suffix('.png')
    subprocess.run(['screencapture', '-x', '-R',
                    f'{x},{y},{right-x},{bottom-y}', str(png)], check=True)
    try:
        subprocess.run(['sips', '-s', 'format', 'jpeg', '-s', 'formatOptions', '80',
                        str(png), '--out', str(dest)],
                       check=True, stdout=subprocess.DEVNULL)
    finally:
        png.unlink(missing_ok=True)


def capture(ready, out):
    info = json.loads(ready.read_text())
    step = ready.stem.removeprefix('shot-')
    ime = [w['bounds'] for w in info['ime_windows']]
    capture_rect([info['window_frame'], *ime], 40, 40,
                 out / f'shot-{step}.jpg')
    caret = info['bounds_for_range_screen']
    if caret is not None and caret['width'] > 0 and caret['height'] > 0:
        expanded = dict(x=caret['x']-220, y=caret['y']-120,
                        width=caret['width']+440, height=caret['height']+240)
        capture_rect([expanded, *ime], 0, 0, out / f'zoom-{step}.jpg')
    ready.with_suffix('.done').write_text('{}\n')


def summary(out, exit_code, timed_out, capture_errors):
    lines = ['| step | check | expected | actual | pass |',
             '|---|---|---|---|---|']
    counts = {'steps': 0, 'pass': 0, 'fail': 0}
    results = out / 'results.jsonl'
    if results.exists():
        for line in results.read_text().splitlines():
            row = json.loads(line)
            counts['steps'] += 1
            for check in row['checks']:
                counts['pass' if check['pass'] else 'fail'] += 1
                cells = [row['step'], check['name'], check['expected'],
                         check['actual'], check['pass']]
                lines.append('| ' + ' | '.join(json.dumps(c, ensure_ascii=False)
                             .replace('|', '\\|').replace('\n', ' ') for c in cells) + ' |')
    lines += ['', f"Steps: {counts['steps']}; pass: {counts['pass']}; fail: {counts['fail']}.",
              f'App exit: {exit_code}; timeout: {timed_out}.', 'launch_mode: open']
    lines += ['', *capture_errors]
    (out / 'summary.md').write_text('\n'.join(lines) + '\n')
    print(json.dumps(counts))


def main():
    app = pathlib.Path(sys.argv[1]).resolve()
    out = pathlib.Path(sys.argv[2]).resolve()
    out.mkdir(parents=True, exist_ok=True)
    handled = set()
    errors = []
    timed_out = False
    process = subprocess.Popen([
        'open', '-n', '-W', '--stdout', str(out / 'app.log'),
        '--stderr', str(out / 'app.log'),
        str(app), '--args', '--d4', str(out)])
    try:
        deadline = time.monotonic() + 240
        while process.poll() is None:
            for ready in sorted(out.glob('shot-*.ready')):
                if ready in handled:
                    continue
                handled.add(ready)
                try:
                    capture(ready, out)
                except (OSError, ValueError, subprocess.CalledProcessError) as error:
                    errors.append(f'{ready.name}: {error}')
            if time.monotonic() >= deadline:
                timed_out = True
                break
            time.sleep(0.05)
    finally:
        if timed_out and (out / 'pid').exists():
            pid = int((out / 'pid').read_text())
            try:
                os.kill(pid, signal.SIGTERM)
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass
        summary(out, process.returncode, timed_out, errors)
    return 0


if __name__ == '__main__':
    sys.exit(main())
