export type RuntimeOwnerIdentity = {
  ownerId: string;
  hostId: string;
  processId: number;
  processStartedAtMs: number;
};

export interface ProcessLiveness {
  isAlive(identity: RuntimeOwnerIdentity): boolean;
}

export interface RuntimeOwnerAuthority {
  readonly ownerId: string;
  readonly ownerGeneration: number;
  canAdoptClaimFrom(ownerId: string): boolean;
  close(): void;
}
