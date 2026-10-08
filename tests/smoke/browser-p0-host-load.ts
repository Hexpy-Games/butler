import { loadavg } from "node:os";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { P0App } from "./browser-p0-measure.ts";

export class HostLoadExceeded extends Error {}
export class HostQuietTimeout extends Error {}
let active: { label: string; samples: ReturnType<typeof observe>[] } | undefined;

function observe(label: string, phase: string) {
  const row = { label, phase, at: new Date().toISOString(), load1: loadavg()[0] };
  console.log(JSON.stringify({ hostLoad: row }));
  const evidence = process.env.BUTLER_P0_EVIDENCE;
  if (evidence) appendFileSync(join(evidence, "host-load.jsonl"), JSON.stringify(row) + "\n");
  return row;
}

/** Six samples span five complete minutes, with no admission inside a window. */
export async function quietHost(label: string, _app?: P0App) {
  if (active) {
    const row = observe(label, "window"); active.samples.push(row);
    if (row.load1 > 6) throw new HostLoadExceeded(`Invalid window ${active.label}: load1=${row.load1}`);
    return row;
  }
  let quietSince: number | undefined;
  // A runner may preserve the same deadline across contaminated attempts.
  const deadline = Math.min(Date.now() + 6 * 60 * 60_000,
    Number(process.env.BUTLER_P0_QUIET_DEADLINE_MS) || Infinity);
  for (;;) {
    const row = observe(label, "admission");
    if (row.load1 < 4) quietSince ??= Date.now();
    else quietSince = undefined;
    if (quietSince !== undefined && Date.now() - quietSince >= 300_000) return row;
    if (Date.now() >= deadline) throw new HostQuietTimeout(`No valid window for ${label} within 6 hours`);
    await Bun.sleep(60_000);
  }
}

/** The caller tears down its owned App on rejection; contaminated runs exit 75. */
export async function hostWindow<T>(label: string, run: () => Promise<T>): Promise<T> {
  if (active) return run();
  await quietHost(label);
  const window = { label, samples: [] as ReturnType<typeof observe>[] }; active = window;
  let timer: ReturnType<typeof setInterval> | undefined;
  const invalid = new Promise<never>((_, reject) => {
    timer = setInterval(() => {
      const row = observe(label, "window"); window.samples.push(row);
      if (row.load1 > 6) reject(new HostLoadExceeded(`Invalid window ${label}: load1=${row.load1}`));
    }, 60_000);
  });
  try {
    await quietHost(label);
    const result = await Promise.race([run(), invalid]);
    await quietHost(label);
    return result;
  } finally {
    clearInterval(timer); active = undefined;
    console.log(JSON.stringify({ hostWindow: window }));
  }
}
