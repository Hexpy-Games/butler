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
    pending = None
    try:
        with open(log, 'wb') as output, subprocess.Popen(
                command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT) as process:
            try:
                for line in process.stdout:
                    output.write(line)
                    text = line.decode('utf-8', errors='replace').rstrip()
                    header = re.match(r'test (.+?) \.\.\. ?(.*)', text)
                    outcome = header[2] if header else text
                    if header:
                        pending = header[1]
                    # Serial libtest can print the name before uncaptured output
                    # and put the outcome alone on a later line. Measure between
                    # outcomes: a buffered name must not hide fixture setup time.
                    if pending and outcome in ('ok', 'FAILED', 'ignored'):
                        now = time.monotonic()
                        print(f'NATIVE-TEST seconds={now-previous:.3f} test {pending} ... {outcome}', flush=True)
                        output.flush()
                        pending = None
                        previous = now
                    elif text.startswith(('running ', 'test result:', 'REFUSAL-SAMPLES',
                                          'REFUSAL-CONTROL-LIVE-SUMMARY', 'Error:')):
                        print(text, flush=True)
                        output.flush()
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
            control.report(results, complete=not errors)
        control.report(results, complete=not errors)
    print(f'NATIVE-TEST-SUMMARY seconds={time.monotonic()-started:.3f} exit={code} log={log}')
    if errors:
        raise RuntimeError('plain I/O control failed') from errors[0]
    return code


if __name__ == '__main__':
    # A narrow Windows console encoding must not interrupt raw-byte capture or
    # replace the native exit code when an error or artifact path is Unicode.
    sys.stdout.reconfigure(errors='backslashreplace')
    sys.exit(capture(sys.argv[1], sys.argv[2:]))
