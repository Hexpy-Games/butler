import { digest } from "../identity/index.ts";

export function subsessionRootWorkId(
  delegationId: string,
  taskId: string,
  childSessionId: string,
): string {
  return `guided-work-${digest(`btcc-guided-work.v1\0work\0subsession-root-work:${delegationId}:${taskId}:${childSessionId}`).slice(0, 64)}`;
}

export function subsessionResultId(childSessionId: string, childTurnId: string): string {
  return `steward-result-${digest(`btcc.subsession.result.v1\0${childSessionId}\0${childTurnId}`).slice(0, 40)}`;
}
