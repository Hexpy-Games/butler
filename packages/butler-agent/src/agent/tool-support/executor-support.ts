import { randomUUID } from "crypto";
import { join } from "path";
import { sanitizePublicText } from "../events/turn-events.ts";
import type {
  EvidenceArtifactRef,
  EvidenceReceipt,
  EvidenceReference,
  PublicWorkObligationKind,
} from "../turn/native/output/tool-types.ts";

const TOOL_PROCESS_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "USERNAME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "SHELL",
  "BUTLER_BUN",
  "BUTLER_WINDOWS_PROCESS_HOST",
] as const;

export function evidenceReceipt(input: {
  producerName: string;
  receiptType: EvidenceReceipt["receiptType"];
  summary: string;
  covers?: string[];
  verified?: boolean;
  references?: EvidenceReference[];
  artifacts?: EvidenceArtifactRef[];
  satisfies?: PublicWorkObligationKind[];
  metrics?: Record<string, number>;
}): EvidenceReceipt {
  return {
    schema: "butler.evidence-receipt.v1",
    id: `receipt-${randomUUID().slice(0, 12)}`,
    producer: {
      kind: "tool",
      name: input.producerName,
    },
    receiptType: input.receiptType,
    verified: input.verified !== false,
    covers: input.covers ?? [],
    summary: sanitizePublicText(input.summary, "Tool evidence was produced.").slice(0, 280),
    references: input.references ?? [],
    ...(input.artifacts && input.artifacts.length > 0 ? { artifacts: input.artifacts } : {}),
    ...(input.satisfies && input.satisfies.length > 0 ? { satisfies: [...new Set(input.satisfies)] } : {}),
    ...(input.metrics ? { metrics: input.metrics } : {}),
  };
}

export function urlReferences(urls: string[]): EvidenceReference[] {
  return [...new Set(urls.map((url) => url.trim()).filter(Boolean))]
    .slice(0, 12)
    .map((url) => ({
      kind: "url",
      ref: url,
    }));
}

export function butlerToolProcessEnvironment(input: {
  butlerData?: string;
} = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of TOOL_PROCESS_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  if (input.butlerData) {
    const artifactRoot = join(input.butlerData, "artifacts", "generated");
    env.BUTLER_DATA = input.butlerData;
    env.BUTLER_ARTIFACTS_DIR = artifactRoot;
    env.BUTLER_ARTIFACT_DIR = artifactRoot;
  }
  return env;
}
