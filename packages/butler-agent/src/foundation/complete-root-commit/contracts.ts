export interface CompleteRootCommitAdapter {
  reconcileExchange(stagedRoot: string, targetRoot: string): boolean;
  exchange(stagedRoot: string, targetRoot: string): void;
  install(stagedRoot: string, absentTargetRoot: string): void;
}
