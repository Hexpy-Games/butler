#!/usr/bin/env python3
"""Developer-only data export. No generator or ICU FFI runs in the Rust binary."""
import ctypes as c, json, pathlib
L = c.CDLL('/usr/lib/libicucore.A.dylib')
P = c.c_void_p
E = c.POINTER(c.c_int32)

def bind(n, args, ret):
    f = getattr(L, n)
    f.argtypes = args
    f.restype = ret
    return f
op = bind('ures_openDirect', [c.c_char_p, c.c_char_p, E], P)
size = bind('ures_getSize', [P], c.c_int32)
typ = bind('ures_getType', [P], c.c_int)
child = bind('ures_getByIndex', [P, c.c_int32, P, E], P)
key = bind('ures_getKey', [P], c.c_char_p)
string = bind('ures_getString', [P, c.POINTER(c.c_int32), E], P)
integer = bind('ures_getInt', [P, E], c.c_int32)
vector = bind('ures_getIntVector', [P, c.POINTER(c.c_int32), E], c.POINTER(c.c_int32))
binary = bind('ures_getBinary', [P, c.POINTER(c.c_int32), E], P)
close = bind('ures_close', [P], None)

def decode(p):
    t = typ(p)
    e = c.c_int32()
    n = c.c_int32()
    if t == 0:
        v = string(p, c.byref(n), c.byref(e))
        return c.string_at(v, n.value * 2).decode('utf-16-le')
    if t == 7:
        return integer(p, c.byref(e))
    if t == 14:
        v = vector(p, c.byref(n), c.byref(e))
        return [v[i] for i in range(n.value)]
    if t == 1:
        v = binary(p, c.byref(n), c.byref(e))
        return list(c.string_at(v, n.value))
    if t in [2, 8]:
        out = {} if t == 2 else []
        for i in range(size(p)):
            q = child(p, i, None, c.byref(e))
            try:
                v = decode(q)
                if t == 2:
                    out[key(q).decode()] = v
                else:
                    out.append(v)
            finally:
                close(q)
        return out
    raise ValueError(t)

def load(pkg, name):
    e = c.c_int32()
    p = op(pkg, name, c.byref(e))
    if e.value > 0:
        raise ValueError((pkg, name, e.value))
    try:
        return decode(p)
    finally:
        close(p)
import argparse, struct, hashlib, datetime, re
parser = argparse.ArgumentParser(description='Regenerate frozen ICU 78.1 / TZ2026c prompt data; developer-only macOS utility')
parser.add_argument('--zoneinfo', type=pathlib.Path, required=True)
parser.add_argument('--output', type=pathlib.Path, required=True)
args = parser.parse_args()
out = args.output
out.mkdir(parents=True, exist_ok=True)
version = (c.c_uint8 * 4)()
L.u_getVersion(version)
assert list(version) == [78, 1, 0, 0], 'Review a new ICU baseline before updating generated data'
z = load(None, b'zoneinfo64')
assert z['TZVersion'] == '2026c' and (args.zoneinfo / '+VERSION').read_text().strip() == '2026c'
U = c.POINTER(c.c_uint16)
L.ucal_getCanonicalTimeZoneID.argtypes = [U, c.c_int32, U, c.c_int32, c.POINTER(c.c_int8), E]
L.ucal_getCanonicalTimeZoneID.restype = c.c_int32
L.ucal_open.argtypes = [U, c.c_int32, c.c_char_p, c.c_int32, E]
L.ucal_open.restype = c.c_void_p
L.ucal_setMillis.argtypes = [c.c_void_p, c.c_double, E]
L.ucal_get.argtypes = [c.c_void_p, c.c_int32, E]
L.ucal_get.restype = c.c_int32
L.ucal_close.argtypes = [c.c_void_p]

def zone_args(name):
    b = name.encode('utf-16-le')
    return (c.c_uint16 * (len(b) // 2)).from_buffer_copy(b)

def canonical(name):
    a = zone_args(name)
    b = (c.c_uint16 * 256)()
    e = c.c_int32()
    sys = c.c_int8()
    n = L.ucal_getCanonicalTimeZoneID(a, len(a), b, 256, c.byref(sys), c.byref(e))
    assert e.value <= 0, (name, e.value)
    return c.string_at(b, n * 2).decode('utf-16-le')

def state(name, epoch):
    a = zone_args(name)
    e = c.c_int32()
    cal = L.ucal_open(a, len(a), b'en_US', 1, c.byref(e))
    assert e.value <= 0
    try:
        L.ucal_setMillis(cal, epoch * 1000, c.byref(e))
        raw = L.ucal_get(cal, 15, c.byref(e))
        dst = L.ucal_get(cal, 16, c.byref(e))
        assert e.value <= 0
        return ((raw + dst) // 1000, int(dst != 0))
    finally:
        L.ucal_close(cal)

def header(trans, types, chars=4):
    return b'TZif3' + bytes(15) + struct.pack('>6I', 0, 0, 0, trans, types, chars)

def pairs(values):
    return [values[i] << 32 | values[i + 1] & 4294967295 for i in range(0, len(values), 2)]
def future_type(footer, offset):
    text = footer.decode()
    pattern = r'(<[^>]+>|[A-Za-z]{3,})([+-]?\d+(?::\d+(?::\d+)?)?)'
    match = re.match(pattern, text)
    assert match, text
    def seconds(value):
        sign = -1 if value.startswith('-') else 1
        parts = [int(v) for v in value.lstrip('+-').split(':')]
        return -sign * sum(v * unit for v, unit in zip(parts, [3600, 60, 1]))
    standard = seconds(match[2])
    rest = text[match.end():]
    daylight = re.match(r'(<[^>]+>|[A-Za-z]{3,})([+-]?\d+(?::\d+(?::\d+)?)?)?', rest)
    if offset == standard:
        return offset, 0, match[1].strip('<>')
    assert daylight, text
    dst_offset = seconds(daylight[2]) if daylight[2] else standard + 3600
    assert offset == dst_offset, (text, offset, standard, dst_offset)
    return offset, 1, daylight[1].strip('<>')

rows = []
footer_missing = []
for name in z['Names']:
    index = z['Names'].index(name)
    data = z['Zones'][index]
    while isinstance(data, int):
        index = data
        data = z['Zones'][index]
    can = canonical(name)
    offsets = data['typeOffsets']
    types = [(offsets[i] + offsets[i + 1], int(offsets[i + 1] != 0), 'LMT') for i in range(0, len(offsets), 2)]
    times = pairs(data.get('transPre32', [])) + data.get('trans', []) + pairs(data.get('transPost32', []))
    mapping = list(data.get('typeMap', []))
    assert len(times) == len(mapping)
    footer = b''
    if 'finalRule' in data:
        paths = [args.zoneinfo / x for x in [name, can, z['Names'][index]]]
        p = next((p for p in paths if p.is_file()), None)
        if p is None:
            assert data['finalRule'] == 'SystemV' and z['Rules']['SystemV'] == [3, -30, -1, 7200, 0, 9, -31, -1, 7200, 0, 3600]
            footer = f"STD{-data['finalRaw'] // 3600}DST,M4.5.0/2,M10.5.0/2".encode()
        else:
            original = p.read_bytes()
            footer = original.rsplit(b'\n', 2)[-2]
            assert footer, (name, 'no footer')
        anchor = int(datetime.datetime(data['finalYear'], 1, 1, tzinfo=datetime.timezone.utc).timestamp())
        t = future_type(footer, state(name, anchor)[0])
        if t not in types:
            types.append(t)
        if times and times[-1] == anchor:
            mapping[-1] = types.index(t)
        else:
            assert not times or times[-1] < anchor
            times.append(anchor)
            mapping.append(types.index(t))
    first = header(0, 1) + struct.pack('>iBB', types[0][0], types[0][1], 0) + b'LMT\x00'
    abbreviations = bytearray()
    type_bytes = bytearray()
    for offset, isdst, abbreviation in types:
        index = len(abbreviations)
        abbreviations.extend(abbreviation.encode() + b'\0')
        assert index < 256
        type_bytes.extend(struct.pack('>iBB', offset, isdst, index))
    second = header(len(times), len(types), len(abbreviations)) + b''.join(struct.pack('>q', v) for v in times) + bytes(mapping) + type_bytes + abbreviations + b'\n' + footer + b'\n'
    rows.append((name, can, first + second))
assert not footer_missing, footer_missing
rows.sort(key=lambda r: r[0].lower())
blob = bytearray(b'BTZ2') + struct.pack('<I', len(rows))
manifest = []
for name, can, data in rows:
    n = name.encode()
    a = can.encode()
    blob += struct.pack('<HHI', len(n), len(a), len(data)) + n + a + data
    manifest.append({'name': name, 'canonical': can, 'sha256': hashlib.sha256(data).hexdigest()})
(out / 'source-2026c.btz').write_bytes(blob)
(out / 'provenance.json').write_text(json.dumps({'source': 'macOS ICU resource zoneinfo64 and /usr/share/zoneinfo POSIX future rules', 'version': '2026c', 'actual_icu': '78.1', 'reported_bun_icu': '74.2', 'sha256': hashlib.sha256(blob).hexdigest(), 'records': manifest}, indent=2) + '\n')
meta = load(None, b'metaZones')['metazoneInfo']
names = load(b'icudt78l-zone', b'root')['zoneStrings']
for key, value in load(b'icudt78l-zone', b'en')['zoneStrings'].items():
    if isinstance(value, dict) and isinstance(names.get(key), dict):
        names[key].update(value)
    else:
        names[key] = value
names = {k: {f: v for f, v in value.items() if f in ['ss', 'sd']} for k, value in names.items() if isinstance(value, dict) and ('ss' in value or 'sd' in value)}
(out / 'names-icu78.json').write_text(json.dumps({'names': names, 'periods': meta}, ensure_ascii=False, separators=(',', ':')) + '\n')
print(len(rows), len(blob), hashlib.sha256(blob).hexdigest())
