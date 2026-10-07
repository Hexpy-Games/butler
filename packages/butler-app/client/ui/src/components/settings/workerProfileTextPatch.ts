import type { WorkerProfile } from "@/app/types.ts";
import { commitWorkerProfileCustomJob } from "./workerProfileUpdates";

/** Canonical patch for a committed text field; unchanged blurs emit no update. */
export function workerProfileTextPatch(
  profile: WorkerProfile,
  field: "label" | "domain" | "prompt" | "job",
  rawText: string,
): Partial<WorkerProfile> | null {
  const trimmed = rawText.trim();
  if (field === "label") return trimmed && trimmed !== profile.label ? { label: trimmed } : null;
  if (field === "job") {
    if (profile.job.kind === "custom" && trimmed === profile.job.text.trim()) return null;
    const job = commitWorkerProfileCustomJob(trimmed);
    return job ? { job } : null;
  }
  if (trimmed === (profile[field] ?? "").trim()) return null;
  return { [field]: trimmed || undefined };
}
