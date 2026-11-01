import { api } from "./api.ts";
import { projectHookText } from "./approvalRequest.ts";
import { chooseAction } from "./confirmation.ts";
import { appCopy } from "./copy.ts";
import type { AccessMode, ProjectHookLine } from "./types.ts";
import { visibleText } from "./visibleText.ts";

interface FolderQuestion { question: { folder: string; hooks: ProjectHookLine[] } | null }

/**
 * Asks about a just-added project's folder, if it has hooks and no answer yet. Anything
 * short of an answer leaves the question to the first message's card, so a failure here
 * never stands in the way of the chat. A list that changed meanwhile also goes there.
 */
export async function askFolderTrust(projectId: string, accessMode: AccessMode, beforeAsking: () => void): Promise<void> {
  const route = `/projects/${encodeURIComponent(projectId)}/folder-trust`;
  try {
    const { question } = await api<FolderQuestion>(route);
    if (!question) return;
    beforeAsking();
    const copy = appCopy.interfaceTemplates.approvalRequest.projectHooks;
    const choice = await chooseAction(copy.receives, {
      title: copy.title, confirmLabel: copy.allow, cancelLabel: copy.deny,
      details: [{ text: visibleText(question.folder), isolate: true },
        { text: question.hooks.map((hook) => visibleText(projectHookText(hook))).join("\n"), isolate: true }],
      ...(accessMode === "full_access" ? { note: copy.unsandboxed } : {}),
    });
    if (choice === "dismissed") return;
    await api(route, { method: "POST", body: JSON.stringify({ trusted: choice === "confirmed", hooks: question.hooks }) });
  } catch {
    // The first message asks.
  }
}
