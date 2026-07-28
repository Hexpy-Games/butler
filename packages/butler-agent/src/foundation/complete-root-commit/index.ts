import { selectCompleteRootCommitAdapter } from "./select-adapter.ts";

const adapter = selectCompleteRootCommitAdapter(process.platform);

export function reconcileCompleteRootExchange(
  stagedRoot: string,
  targetRoot: string,
): boolean {
  return adapter.reconcileExchange(stagedRoot, targetRoot);
}

export function exchangeCompleteRoots(
  stagedRoot: string,
  targetRoot: string,
): void {
  adapter.exchange(stagedRoot, targetRoot);
}

export function installCompleteRoot(
  stagedRoot: string,
  absentTargetRoot: string,
): void {
  adapter.install(stagedRoot, absentTargetRoot);
}

export type { CompleteRootCommitAdapter } from "./contracts.ts";
