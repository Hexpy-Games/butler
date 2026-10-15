// Screenshot fixture: the seven real product containers, without provider calls.
import { createRoot } from "react-dom/client";
import { Stack, SurfacePanel, Typo } from "@/butler-ds";
import "@/butler-ds/tokens.css";
import { setAppCopyLanguage } from "@/app/copy.ts";
import { firstRunCopy } from "@/app/firstRunSetup.ts";
import { MessageMarkdown } from "@/components/conversation/MessageMarkdown.tsx";
import { ProjectDocumentMarkdownContent } from "@/components/management/ProjectDocumentMarkdownContent.tsx";
import { ArtifactViewer } from "@/components/artifacts/ArtifactViewer.tsx";
import { AboutSettings } from "@/components/settings/AboutSettings.tsx";
import { FirstRunWelcome } from "@/components/first-run/FirstRunWelcome.tsx";
import { FirstRunConsent } from "@/components/first-run/FirstRunConsent.tsx";
import { FirstRunKeyForm } from "@/components/first-run/FirstRunKeyForm.tsx";
import type { FirstRunFlow } from "@/components/first-run/useFirstRunFlow.ts";

const params = new URLSearchParams(location.search);
const language = params.get("language") === "ko" ? "ko" : "en";
setAppCopyLanguage(language);
document.body.classList.add(`theme-${params.get("theme") ?? "light"}`);
const noop = () => {};
const flow = { copy: firstRunCopy[language], language, mode: "first-run", step: "consent", view: { kind: "list" }, savingConsent: false,
  readiness: { status: "ready" }, commit: { connected: null }, focusStart: false,
  start: noop, agree: noop, decline: noop, backToWelcome: noop, backToList: noop, setLanguage: noop,
  connectKey: noop, retryPreparation: noop } as unknown as FirstRunFlow;
const markdown = "# [Heading](https://cached.invalid/heading)\n\n[Titled link](https://cached.invalid/title), https://cached.invalid/ and [Unavailable](https://failed.invalid/).\n\n| Source | Reference |\n| --- | --- |\n| Docs | [Table](https://cached.invalid/table) |";
const artifact = { id: "fixture", title: "reference.md", kind: "document", safe_path_label: "reference.md",
  url: "/message-files/file-11111111-1111-4111-8111-111111111111", size_bytes: markdown.length,
  created_at: "2026-10-06T00:00:00.000Z", open_action: "route" as const };
const screens = [
  ["message", <MessageMarkdown text={markdown} />],
  ["project-document", <ProjectDocumentMarkdownContent markdown={markdown} />],
  ["artifact", <ArtifactViewer artifact={artifact} onBack={noop} />],
  ["about", <AboutSettings />],
  ["welcome", <FirstRunWelcome flow={flow} />],
  ["consent", <FirstRunConsent flow={flow} />],
  ["key", <FirstRunKeyForm cardId="claude" flow={flow} />],
] as const;
createRoot(document.getElementById("root")!).render(
  <Stack gap="lg">{screens.map(([name, screen]) => (
    <SurfacePanel key={name} data-test-class={`reference-screen-${name}`}>
      <Stack gap="md"><Typo.H4>{name}</Typo.H4>{screen}</Stack>
    </SurfacePanel>
  ))}</Stack>,
);
