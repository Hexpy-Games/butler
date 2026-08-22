import { createHash } from "node:crypto";

const SHORT_BRANCH_DIGEST_LENGTH = 12;

export function shortSessionWorktreeBranch(sessionId: string): string {
  return `butler/s/${shortDigest("session", sessionId)}`;
}

export function shortStewardWorktreeBranch(relationId: string): string {
  return `butler/st/${shortDigest("steward", relationId)}`;
}

function shortDigest(kind: string, identity: string): string {
  return createHash("sha256")
    .update(`butler.worktree-branch.v1\0${kind}\0${identity}`)
    .digest("hex")
    .slice(0, SHORT_BRANCH_DIGEST_LENGTH);
}
