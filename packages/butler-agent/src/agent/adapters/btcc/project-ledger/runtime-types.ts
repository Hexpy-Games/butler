export type ProjectLedgerHead = {
  schema: "butler.btcc-project-ledger-head.v1";
  projectRoot: string;
  sourceSha256: string;
  sourceFileCount: number;
  storageSha256: string;
  storageEntryCount: number;
  /** Present only for changed-record publications; old heads retain full-root semantics. */
  recordPaths?: string[];
};

export type ProjectLedgerCorePublication = {
  schema: "project-ledger.prepared-publication.v1";
  publicationId: string;
  canonicalRoot: string;
  candidateRoot: string;
  journalPath: string;
  claimPath: string;
  base: ProjectLedgerHead;
  candidateHead: ProjectLedgerHead;
};
