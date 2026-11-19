import { GatewayError } from "../../../butler-protocol/src/client/index.ts";

export type Problem = "invalidCode" | "hostNotAllowed" | "needsPairing" | "versionMismatch" | "notButler" | "unreachable" | "failed";

const byCode = new Map<string, Problem>([
  ["invalid_connection_code", "invalidCode"],
  ["host_not_allowed", "hostNotAllowed"],
  ["local_auth_required", "needsPairing"],
  ["protocol_mismatch", "versionMismatch"],
  ["not_butler", "notButler"],
]);

export function problemFrom(error: unknown): Problem {
  if (!(error instanceof GatewayError)) return "unreachable";
  return byCode.get(error.code) ?? "failed";
}
