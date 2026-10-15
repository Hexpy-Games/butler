"""Save complete native output without PowerShell formatting every probe line.

Usage: capture-native-tests.py LOG COMMAND [ARG ...]
The raw artifact retains every byte; the console shows outcomes and timings.
A separate plain-I/O thread measures the harness temp volume concurrently.
"""
import importlib.util
from pathlib import Path
import re
import subprocess
import sys
import threading
import time


def capture(log, command):
    spec = importlib.util.spec_from_file_location(
        'io_control', Path(__file__).with_name('storage-io-control.py'))
    control = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(control)
    stop = threading.Event()
    results, errors = [], []
    worker = threading.Thread(target=control.run, args=(stop, results, errors))
    worker.start()
    started = previous = time.monotonic()
    try:
        with open(log, 'wb') as output, subprocess.Popen(
                command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT) as process:
            try:
                for line in process.stdout:
                    output.write(line)
                    text = line.decode('utf-8', errors='replace').rstrip()
                    if re.match(r'test .* \.\.\. (ok|FAILED|ignored)$', text):
                        now = time.monotonic()
                        print(f'NATIVE-TEST seconds={now-previous:.3f} {text}', flush=True)
                        previous = now
                    elif text.startswith(('running ', 'test result:', 'REFUSAL-SAMPLES',
                                          'REFUSAL-CONTROL-LIVE-SUMMARY', 'Error:')):
                        print(text, flush=True)
                        if text.startswith('running '):
                            previous = time.monotonic()
                code = process.wait()
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()
    finally:
        stop.set()
        worker.join()
        # Include control observations in the artifact as well as the console.
        import contextlib
        with open(log, 'a', encoding='utf-8') as output, contextlib.redirect_stdout(output):
            control.report(results)
        control.report(results)
    print(f'NATIVE-TEST-SUMMARY seconds={time.monotonic()-started:.3f} exit={code} log={log}')
    if errors:
        raise RuntimeError('plain I/O control failed') from errors[0]
    return code


if __name__ == '__main__':
    sys.exit(capture(sys.argv[1], sys.argv[2:]))
