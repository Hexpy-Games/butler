export interface SessionBranchRequest {
  requestId: string;
  sourceSessionId: string;
  sourceMessageId: string;
  title: string;
  followUp?: string;
  destination: { kind: "chat" } | { kind: "project"; projectId: string } |
    { kind: "new_project"; name: string };
}
export interface SessionBranchSeed {
  summary: string;
  sourceSessionId: string;
  sourceMessageId: string;
  canonicalSessionId: string | null;
  canonicalMessageId: string | null;
  sourceThroughMessageId: string;
  excerptTruncated: boolean;
}
