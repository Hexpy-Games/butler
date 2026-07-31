export type LegacyWorkRecordSnapshot = {
  recordId: string;
  status: string;
  content: unknown;
};

export type LegacyProjectWorkSnapshot = {
  sourceProgramId: string;
  sourceRevision: string;
  goalContract: unknown;
  plan: unknown;
  works: LegacyWorkRecordSnapshot[];
  tasks: LegacyWorkRecordSnapshot[];
  referencedRecords: Array<{
    recordId: string;
    content: unknown;
  }>;
};

export interface LegacyProjectWorkSource {
  loadOpenWork(input: {
    projectRef: string;
    programIds: readonly string[];
  }): Promise<LegacyProjectWorkSnapshot | null>;
}
