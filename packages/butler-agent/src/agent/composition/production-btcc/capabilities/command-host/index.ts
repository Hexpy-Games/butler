import { selectCommandHostAdapter } from "./select-adapter.ts";

export const commandHost = selectCommandHostAdapter(process.platform);

export type { CommandHostAdapter, CommandInvocation } from "./contracts.ts";
