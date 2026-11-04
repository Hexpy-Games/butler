"""Run the D4 research harness and acknowledge requested full-screen captures."""
import json
import math
import os
import signal
import tempfile
import pathlib
import subprocess
import sys
import time


def capture(ready, out):
    info = json.loads(ready.read_text())
    step = ready.stem.removeprefix('shot-')
    rects = [info['window_frame']]
    rects += [w['bounds'] for w in info['foreign_windows']]
    scale = info['backing_scale']
    x = max(0, math.floor((min(r['x'] for r in rects) - 40) * scale))
    y = max(0, math.floor((min(r['y'] for r in rects) - 40) * scale))
    right = math.ceil((max(r['x'] + r['width'] for r in rects) + 40) * scale)
    bottom = math.ceil((max(r['y'] + r['height'] for r in rects) + 40) * scale)
    full = out / f'full-{step}.png'
    subprocess.run(['screencapture', '-x', str(full)], check=True)
    try:
        dimensions = subprocess.check_output(
            ['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', str(full)], text=True)
        values = dict(line.strip().split(': ', 1) for line in dimensions.splitlines()[1:])
        right = min(right, int(values['pixelWidth']))
        bottom = min(bottom, int(values['pixelHeight']))
        subprocess.run(['sips', '--cropToHeightWidth', str(bottom-y), str(right-x),
                        '--cropOffset', str(y), str(x), str(full)], check=True,
                       stdout=subprocess.DEVNULL)
        subprocess.run(['sips', '-s', 'format', 'jpeg', '-s', 'formatOptions', '80',
                        str(full), '--out', str(out / f'shot-{step}.jpg')],
                       check=True, stdout=subprocess.DEVNULL)
    finally:
        full.unlink(missing_ok=True)
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
    with tempfile.TemporaryDirectory(prefix='d4-home-') as home, \
            tempfile.TemporaryDirectory(prefix='d4-data-') as data, \
            tempfile.TemporaryDirectory(prefix='d4-tmp-') as tmp:
        process = subprocess.Popen([
            'open', '-n', '-W', '--stdout', str(out / 'app.log'),
            '--stderr', str(out / 'app.log'), '--env', f'HOME={home}',
            '--env', f'BUTLER_DATA={data}', '--env', f'TMPDIR={tmp}',
            '--env', 'MallocNanoZone=0', '--env', 'OS_ACTIVITY_MODE=disable',
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
