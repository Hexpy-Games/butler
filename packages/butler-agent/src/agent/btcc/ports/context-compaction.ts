/** A context projection only. Execution and permissions remain owned by Turn. */
export type ContextCompaction = {
  sourceDigest: string;
  coveredUnits: number;
  summary: string;
};

export interface ContextCompactionStore {
  load(turnId: string): ContextCompaction[];
  save(turnId: string, value: ContextCompaction): void;
}
