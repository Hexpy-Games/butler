"""Content-checked plain file I/O control, independent of Butler and SQLite.

Use the same temp volume as the harness. Keep UTC boundaries for correlation
with command_file_timing; buffer results so console output cannot stall I/O.
"""
import os
from pathlib import Path
import tempfile
import time


def sample(root, index):
    payload = (f'{index}: complete control payload\n'.encode() * 256)
    temporary = root / f'fresh-{index}.tmp'
    published = root / 'published.bin'
    marks = [time.time_ns() // 1000]
    started = time.perf_counter_ns()
    with temporary.open('xb') as output:
        marks.append(time.time_ns() // 1000)
        output.write(payload)
        output.flush()
        marks.append(time.time_ns() // 1000)
        os.fsync(output.fileno())
        marks.append(time.time_ns() // 1000)
    os.replace(temporary, published)
    marks.append(time.time_ns() // 1000)
    with (root / 'append.bin').open('ab') as output:
        output.write(payload)
        output.flush()
        marks.append(time.time_ns() // 1000)
        os.fsync(output.fileno())
        marks.append(time.time_ns() // 1000)
    elapsed = (time.perf_counter_ns() - started) // 1000
    assert published.read_bytes() == payload, 'complete published contents'
    return marks, elapsed, payload


def run(stop, results, errors):
    try:
        with tempfile.TemporaryDirectory(prefix='plain-io-control-') as directory:
            root = Path(directory)
            expected = bytearray()
            while not stop.is_set():
                marks, elapsed, payload = sample(root, len(results))
                expected.extend(payload)
                results.append((marks, elapsed))
                if stop.wait(1):
                    break
            if expected:
                assert (root / 'append.bin').read_bytes() == expected, 'complete append order'
    except BaseException as error:
        errors.append(error)


def report(results, complete):
    for marks, elapsed in results:
        fields = zip(('start', 'created', 'written', 'synced', 'renamed',
                      'append_written', 'append_synced'), marks)
        print('IO-CONTROL ' + ' '.join(f'{key}_utc_us={value}' for key, value in fields)
              + f' elapsed_us={elapsed}')
    if results:
        values = sorted(elapsed for _, elapsed in results)
        print(f'IO-CONTROL-SUMMARY n={len(values)} p50_us={values[len(values)//2]} '
              f'max_us={values[-1]} complete={str(complete).lower()}')
