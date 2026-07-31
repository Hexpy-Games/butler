import { digest } from "./identity.ts";

export function guidedWorkRecordId(kind: string, identity: string): string {
  return `guided-${kind}-${digest(`btcc-guided-work.v1\0${kind}\0${identity}`)}`;
}
