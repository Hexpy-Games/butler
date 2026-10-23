import { AlertCircle, CheckCircle2, Circle, CircleX, Eye, Spinner } from "@/butler-ds";
import type { CanonStatus, WorkTaskStatus } from "@/app/canonApi.ts";
export function CanonStatusGlyph({ status }: { status: CanonStatus | WorkTaskStatus }) {
  if (status === "in_progress" || status === "running") return <Spinner size={16} />;
  if (status === "done" || status === "completed") return <CheckCircle2 size="sm" />;
  if (status === "in_review") return <Eye size="sm" />;
  if (["blocked", "failed", "held", "stopped"].includes(status)) return <AlertCircle size="sm" />;
  if (status === "cancelled") return <CircleX size="sm" />;
  return <Circle size="sm" />;
}
