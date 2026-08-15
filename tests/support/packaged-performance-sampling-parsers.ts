export function parseCpuTimeMs(value: string | undefined): number | null {
  if (!value) return null;
  const [dayText, clockText] = value.includes("-")
    ? value.split("-", 2)
    : ["0", value];
  const clock = clockText!.split(":").map(Number);
  const seconds = clock.pop();
  const minutes = clock.pop() ?? 0;
  const hours = clock.pop() ?? 0;
  const days = Number(dayText);
  if (![days, hours, minutes, seconds].every(Number.isFinite)) return null;
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds!) * 1_000;
}

export function parseDarwinFootprint(output: string): { physicalFootprintBytes: number | null; reason: string } {
  const match = output.match(/\bFootprint:\s*([\d,.]+\s*[BKMGTP]+)/iu);
  const value = match ? parseByteValue(match[1]) : null;
  return {
    physicalFootprintBytes: value,
    reason: output.trim() ? "footprint output did not include a physical footprint" : "footprint command unavailable or denied",
  };
}

export function parseDarwinWritableResident(output: string): number | null {
  const match = output.match(/Writable regions:[^\n]*\bresident=([\d.]+\s*[BKMGTP]+)/iu);
  return match ? parseByteValue(match[1]) : null;
}

export function parseLinuxKiB(value: string, pattern: RegExp): number | null {
  const match = value.match(pattern);
  const kib = Number(match?.[1]);
  return Number.isFinite(kib) ? kib * 1024 : null;
}

export function parseByteValue(value: string | undefined): number | null {
  if (!value) return null;
  const match = value.trim().match(/^([\d,.]+)\s*([BKMGTP]+)$/iu);
  if (!match) return null;
  const number = Number(match[1]!.replaceAll(",", ""));
  const unit = match[2]!.toUpperCase();
  const power = Math.max(0, "BKMGTP".indexOf(unit[0]!));
  return Number.isFinite(number) ? number * 1024 ** power : null;
}

export function countConnections(output: string): number {
  return output.split(/\r?\n/u)
    .filter((line) => /\b(?:TCP|UDP|unix|IPv4|IPv6)\b/iu.test(line)).length;
}

export function finiteOrNull(value: number | undefined): number | null {
  return Number.isFinite(value) ? value! : null;
}
