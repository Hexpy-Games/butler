export function butlerM1V2InfrastructureGate(evidence: Record<string, unknown>): {
  code: "authentication_unavailable" | "measurement_unavailable";
  diagnostic: string;
} | null {
  if (evidence.ok === true) return null;
  const launches = Array.isArray(evidence.launches) ? evidence.launches : [];
  if (launches.length === 0) {
    return {
      code: "measurement_unavailable",
      diagnostic: prelaunchFailureDiagnostic(evidence.failure),
    };
  }
  const requests = Array.isArray(evidence.providerRequests)
    ? evidence.providerRequests.map(recordValue)
      .filter((row): row is Record<string, unknown> => Boolean(row))
    : [];
  if (requests.some((request) => request.status === 401 || request.status === 403)) {
    return {
      code: "authentication_unavailable",
      diagnostic: "Butler provider authentication gated the M1 arm.",
    };
  }
  if (
    requests.some((request) => request.status === 429) ||
    requests.length > 0 && requests.every((request) =>
      request.status === null && request.termination === "failed",
    )
  ) {
    return {
      code: "measurement_unavailable",
      diagnostic: "Butler provider quota or network availability gated the M1 arm.",
    };
  }
  return null;
}

function prelaunchFailureDiagnostic(value: unknown): string {
  const failure = recordValue(value);
  const stage = failure?.stage === "bundled_agent_preparation" ||
      failure?.stage === "electron_launch_preflight" ||
      failure?.stage === "renderer_ready"
    ? failure.stage
    : null;
  const cause = failure?.cause === "disk_space_exhausted" ||
      failure?.cause === "resource_inspection_failed" ||
      failure?.cause === "electron_exited" ||
      failure?.cause === "port_conflict" ||
      failure?.cause === "renderer_ready_timeout"
    ? failure.cause
    : null;
  const owner = failure?.owner === "electron_harness" ||
      failure?.owner === "electron_process"
    ? failure.owner
    : null;
  const exitCode = failure?.exitCode === null ||
      typeof failure?.exitCode === "number" && Number.isSafeInteger(failure.exitCode)
    ? failure.exitCode
    : null;
  const signal = failure?.signal === null ||
      typeof failure?.signal === "string" && /^SIG[A-Z0-9]+$/u.test(failure.signal)
    ? failure.signal
    : null;
  if (!stage || !cause || !owner) {
    return "Butler Electron/App setup did not reach a product launch.";
  }
  return "Butler Electron/App setup did not reach a product launch " +
    `(stage=${stage}, cause=${cause}, owner=${owner}, ` +
    `exitCode=${String(exitCode)}, signal=${String(signal)}).`;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
