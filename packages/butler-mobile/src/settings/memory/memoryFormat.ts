import type { AppCopy } from "../../../../butler-i18n/src/index.ts";
import type { Instruction } from "../types";

// Desktop: useInstructions.ts and InstructionRow.tsx:11-13.
export function instructionScope(item: Instruction, copy: AppCopy["settings"]["memory"]) {
  return item.scope.kind === "session" ? copy.thisChat : item.scope.kind === "all" ? copy.allChats : item.scope.project_name || copy.project;
}
export function instructionMeta(item: Instruction, copy: AppCopy["settings"]["memory"]) {
  const hours = Math.max(1, Math.ceil((Date.parse(item.expires_at ?? "") - Date.now()) / 3_600_000));
  const duration = item.duration === "this chat" ? copy.thisChatOnly : !item.expires_at || item.duration === "always" ? ""
    : hours <= 24 ? copy.expiresInHours(hours) : copy.expiresInDays(Math.ceil(hours / 24));
  return item.scope.kind === "session" && item.duration === "this chat" ? duration
    : [instructionScope(item, copy), item.duration === "always" ? "" : duration].filter(Boolean).join(" · ");
}
