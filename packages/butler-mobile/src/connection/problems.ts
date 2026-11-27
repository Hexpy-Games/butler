import { GatewayError } from "../../../butler-protocol/src/client/index.ts";

export type Problem = "invalidCode" | "rejected" | "expired" | "hostNotAllowed" | "needsPairing" | "versionMismatch" | "notButler" | "unreachable" | "failed" | "desktopOffline" | "relayOff" | "cancelled";

const byCode = new Map<string, Problem>([
  ["invalid_connection_code", "invalidCode"],
  ["pairing_rejected", "rejected"],
  ["pairing_expired", "expired"],
  ["host_not_allowed", "hostNotAllowed"],
  ["local_auth_required", "needsPairing"],
  ["protocol_mismatch", "versionMismatch"],
  ["not_butler", "notButler"],
  ["desktop_offline", "desktopOffline"],
  ["tunnel_not_found", "relayOff"],
  ["tunnel_not_in_plan", "relayOff"],
]);

export function problemFrom(error: unknown): Problem {
  if (!(error instanceof GatewayError)) return "unreachable";
  return byCode.get(error.code) ?? "failed";
}
