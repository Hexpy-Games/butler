import { readFileSync } from "node:fs";
import type { BenchmarkResultFile, VisualReviewEvidence, VisualReviewFile } from "./contracts.ts";
import { VISUAL_REVIEW_SCHEMA } from "./contracts.ts";
import { sanitizeIdentifier } from "./identifiers.ts";

/** Reads the checked-in, human-authored visual review input without retaining
 * screenshot paths, prompts, or free-form reviewer comments. */
export function readVisualReviewFile(path: string): VisualReviewFile {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw new Error("Visual review file is not valid JSON.");
  }
  const record = asRecord(value);
  if (record?.schema !== VISUAL_REVIEW_SCHEMA || !Array.isArray(record.reviews)) {
    throw new Error("Visual review schema mismatch.");
  }
  const seen = new Set<string>();
  const reviews = record.reviews.map((entry) => {
    const review = asRecord(entry);
    const armKey = sanitizeIdentifier(review?.armKey);
    const reviewerLabel = sanitizeIdentifier(review?.reviewerLabel);
    const rubricVersion = sanitizeIdentifier(review?.rubricVersion);
    const score = review?.score;
    if (!armKey || !reviewerLabel || !rubricVersion || typeof score !== "number" || !Number.isInteger(score) || score < 1 || score > 5) {
      throw new Error("Visual review entries require a safe arm key, reviewer, rubric, and an integer score from 1 to 5.");
    }
    if (seen.has(armKey)) throw new Error(`Visual review contains a duplicate arm: ${armKey}`);
    seen.add(armKey);
    return { armKey, score, reviewerLabel, rubricVersion };
  });
  return { schema: VISUAL_REVIEW_SCHEMA, reviews };
}

/** Applies only reviews that target landing-page observations. The result is
 * a new in-memory value and is persisted by the normal checkpoint store. */
export function applyVisualReviews(
  result: BenchmarkResultFile,
  reviewFile: VisualReviewFile,
): BenchmarkResultFile {
  const byKey = new Map(result.observations.map((observation) => [observation.arm.key, observation]));
  const observations = result.observations.map((observation) => ({ ...observation }));
  const indexByKey = new Map(observations.map((observation, index) => [observation.arm.key, index]));
  for (const review of reviewFile.reviews) {
    const observation = byKey.get(review.armKey);
    const index = indexByKey.get(review.armKey);
    if (!observation || index === undefined) throw new Error(`Visual review arm is not present in the benchmark result: ${review.armKey}`);
    if (observation.arm.scenario !== "butler_landing_page") throw new Error(`Visual review arm is not a landing-page observation: ${review.armKey}`);
    if (observation.terminalState === "gated" || observation.terminalState === "failed" || observation.terminalState === "timed_out") {
      throw new Error(`Visual review requires a completed landing observation: ${review.armKey}`);
    }
    const screenshotRefs = [...observation.evidenceRefs, ...observation.evaluation.evidenceRefs];
    if (!screenshotRefs.some((ref) => /desktop/iu.test(ref)) || !screenshotRefs.some((ref) => /mobile/iu.test(ref))) {
      throw new Error(`Visual review requires persisted desktop and mobile screenshots: ${review.armKey}`);
    }
    const evidence: VisualReviewEvidence = {
      score: review.score,
      reviewerLabel: review.reviewerLabel,
      rubricVersion: review.rubricVersion,
    };
    observations[index] = {
      ...observation,
      visualReview: evidence,
      evaluation: {
        ...observation.evaluation,
        visualQuality: evidence.score,
        evaluatorNotes: [
          ...observation.evaluation.evaluatorNotes.filter((note) => !note.startsWith("visual-review:")),
          `visual-review:${evidence.rubricVersion}`,
        ],
      },
    };
  }
  return { ...result, observations };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
