import type { ContentRef } from "../../core/index.ts";

export type TargetKind = "file" | "directory";

export type SnapshotEntry =
  | { path: string; kind: "directory"; mode: number }
  | {
      path: string;
      kind: "file";
      mode: number;
      byteLength: number;
      contentSha256: string;
    }
  | { path: string; kind: "symlink"; mode: number; linkTarget: string };

export interface MaterializedSnapshot {
  ref: ContentRef;
  targetState: "present" | "absent";
  targetKind: TargetKind;
  entries: SnapshotEntry[];
}
