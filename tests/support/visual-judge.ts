import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type VisionRequest = {
  model: "openai/gpt-6-luna";
  messages: { role: "user"; content: ({ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } })[] }[];
};
export type VisionVerdict = { pass: boolean; reason: string };
export type VisualJudgeTransport = { mode: "stub" | "replay"; judge(request: VisionRequest): Promise<unknown> };

/** Optional semantic comparison; no credentials, live transport or implicit passing stub. */
export async function judgeScreenshotPair(options: {
  actual: string; expected?: string; expectation: string; transport?: VisualJudgeTransport;
}): Promise<VisionVerdict | undefined> {
  if (process.env.BUTLER_VISUAL_JUDGE !== "1") return undefined;
  assert(options.expected, "Visual judge requires an expected/before screenshot");
  assert(options.expectation.trim(), "Visual judge requires a written expectation");
  const images = [options.expected, options.actual].map(path => readFileSync(path));
  const request: VisionRequest = { model: "openai/gpt-6-luna", messages: [{ role: "user", content: [
    { type: "text", text: `Compare expected (first image) with actual (second image). Judge this expectation: ${options.expectation}\nAllow animation phase and artwork colour variation. Reject missing art, clipping, overlap or unreadable content. Return JSON {"pass":boolean,"reason":string}.` },
    ...images.map(image => ({ type: "image_url" as const, image_url: { url: `data:image/png;base64,${image.toString("base64")}` } })),
  ] }] };
  const digest = createHash("sha256").update(JSON.stringify(request)).digest("hex");
  const output = join(dirname(options.actual), `${digest.slice(0, 16)}-judge`);
  mkdirSync(output, { recursive: true });
  copyFileSync(options.expected, join(output, "expected.png"));
  copyFileSync(options.actual, join(output, "actual.png"));
  writeFileSync(join(output, "request.json"), JSON.stringify(request, null, 2));
  const transport = options.transport ?? replayTransport(digest);
  assert(["stub", "replay"].includes(transport.mode), "Tests permit only stub/replay vision transports");
  const response = await transport.judge(request);
  writeFileSync(join(output, "response.json"), JSON.stringify(response, null, 2));
  assert(response && typeof response === "object", "Invalid vision verdict");
  const verdict = response as VisionVerdict;
  assert(typeof verdict.pass === "boolean" && typeof verdict.reason === "string" && verdict.reason.trim(), "Invalid vision verdict");
  assert(verdict.pass, `Visual judge: ${verdict.reason}; evidence: ${output}`);
  return verdict;
}

function replayTransport(digest: string): VisualJudgeTransport {
  const path = process.env.BUTLER_VISUAL_JUDGE_REPLAY;
  assert(path, "Enabled visual judge requires BUTLER_VISUAL_JUDGE_REPLAY or an explicit stub transport");
  const cassette = JSON.parse(readFileSync(path, "utf8")) as Record<string, VisionVerdict>;
  assert(Object.hasOwn(cassette, digest), `No visual replay for request ${digest}`);
  return { mode: "replay", judge: async () => cassette[digest] };
}
