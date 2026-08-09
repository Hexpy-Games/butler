export function runtimeFaultFailureMessage(
  runtimeFault: Record<string, unknown> | null,
  fallback: { code: string; message: string },
): { code: string; message: string } {
  if (!runtimeFault) return fallback;
  const publicSummary = typeof runtimeFault.publicSummary === "string"
    ? runtimeFault.publicSummary.trim()
    : "";
  return {
    code: "runtime_fault",
    message: publicSummary || fallback.message,
  };
}
