import { createHmac } from "node:crypto";
import type { PhaseContinuityPrivateDigester } from
  "../../packages/butler-agent/src/agent/btcc/ports/model-round.ts";

export const TEST_PHASE_CONTINUITY_PRIVATE_DIGESTER: PhaseContinuityPrivateDigester = {
  digest(fieldDomain, exactUtf8Bytes) {
    return createHmac("sha256", Buffer.alloc(32, 19))
      .update(`${fieldDomain}\0${exactUtf8Bytes}`, "utf8")
      .digest("base64url")
      .slice(0, 43);
  },
};
