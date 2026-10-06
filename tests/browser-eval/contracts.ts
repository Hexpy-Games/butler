import type { Page } from "playwright";

export interface ReceivedEvent {
  fixture: string; target: string; type: string; value?: string; origin: string; method?: string;
}
export interface FixtureTruth {
  id: string; targets: string[]; decoys: string[]; covered: Record<string, string>; settleMs: number;
  success: { required: { target: string; type: string; value?: string }[]; forbidden: { target: string; type: string; value?: string }[] };
}
export interface SnapshotNode {
  ref: string; targetId?: string; frameOrigin: string; actionable: boolean; coveredBy?: string;
}
export interface PerceptionSnapshot {
  text: string; nodes: SnapshotNode[]; scriptMs: number; gridSampleMs?: number;
}
/** Provider never receives gold truth. P2a can adapt Electron isolated-world snapshots here. */
export interface SnapshotProvider {
  arm: string;
  snapshot(page: Page): Promise<PerceptionSnapshot>;
}
export interface L1Metrics {
  id: string; arm: string; realFound: number; realTotal: number; decoysLeaked: number; decoysTotal: number;
  coveredCorrect: number; coveredTotal: number; realTargetRecall: number; decoyLeakRate: number;
  coveredAnnotationAccuracy: number | null; snapshotBytes: number; snapshotTokensEstimate: number;
  scriptMs: number; gridSampleMs: number | null;
}
/** L2–L4 schema; unavailable values remain null, never synthetic zeroes. */
export interface TaskMetrics {
  task: string; arm: string; run: number; success: boolean;
  wrongElementEvents: number; stepAccuracy: number | null;
  refusals: { reason: "point_mismatch" | "blocked_by" | "transparent_overlay" | "frame_not_granted"; recovered: boolean }[];
  cost: { steps: number; modelCalls: number; toolCalls: number; images: number; inputTokens: number; outputTokens: number; providerSendBytes: number; costPerSuccess: number | null };
  latency: { wallMs: number; modelMs: number; executorMs: number; observeP95Ms: number };
  trace: { observationHash: string; imagePhash: string | null; resolvedTargets: string[] };
}
