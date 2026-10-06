/** Uses the product containers and merged DS with a deterministic preload fixture. */
import React from "../../packages/butler-app/client/ui/node_modules/react";
import { createRoot } from "react-dom/client";
import { AdaptiveShell, AdaptiveShellSidebar, AdaptiveShellWorkspace, Button, Dialog, DialogContent, DialogTitle, DialogTrigger, Stack } from "../../packages/butler-app/client/ui/src/libs/design-system";
import { OutputFrame } from "../../packages/butler-app/client/ui/src/components/artifacts/OutputFrame";
import { BrowserArea } from "../../packages/butler-app/client/ui/src/components/browser/BrowserArea";
import { BrowserEntry } from "../../packages/butler-app/client/ui/src/components/browser/BrowserEntry";
import { Titlebar } from "../../packages/butler-app/client/ui/src/components/layout/Titlebar";
import { setAppCopyLanguage } from "../../packages/butler-app/client/ui/src/app/copy";
import { useButlerStore } from "../../packages/butler-app/client/ui/src/app/store";
import type { BrowserSnapshot } from "../../packages/butler-app/client/ui/src/components/browser/browserBridge";
import "../../packages/butler-app/client/ui/src/libs/design-system/tokens.css";

const params = new URLSearchParams(location.search);
const locale = params.get("locale") ?? "en";
const theme = params.get("theme") === "dark" ? "dark" : "light";
setAppCopyLanguage(locale);
document.body.classList.add(`theme-${theme}`, "sidebar-translucent");
const mode = params.get("state") ?? "empty";
useButlerStore.setState({ view: { kind: mode === "output" ? "session" : "browser" }, activeChatId: "general" });
const canvas = document.createElement("canvas");
canvas.width = 1440; canvas.height = 720;
const context = canvas.getContext("2d")!;
context.fillStyle = "#eaf0ef"; context.fillRect(0, 0, 1440, 720);
context.fillStyle = "#123432"; context.font = "36px sans-serif"; context.fillText("Local fixture page", 48, 80);
const still = canvas.toDataURL("image/jpeg");
let serial = 0;
let snapshot: BrowserSnapshot = {
  enabled: mode !== "disabled", blocked: false, activeId: ["empty", "output"].includes(mode) ? null : "one", nativeCovered: false,
  tabs: ["empty", "output"].includes(mode) ? [] : [{ id: "one", owner: "mine", title: "Local fixture", url: "https://example.com/", favicon: "",
    status: mode === "crash" ? "crashed" : "idle", canBack: true, canForward: true }],
};
const subscribers = new Set<(value: BrowserSnapshot) => void>();
const publish = () => { for (const subscriber of subscribers) subscriber({ ...snapshot, tabs: [...snapshot.tabs] }); };
const addressListeners = new Set<() => void>();
window.butlerBrowser = {
  subscribe(callback) { subscribers.add(callback); callback(snapshot); return () => { subscribers.delete(callback); }; },
  onAddress(callback) { addressListeners.add(callback); return () => { addressListeners.delete(callback); }; },
  async call(op, raw) {
    const input = raw as { id?: string; value?: string; tabId?: string; index?: number; owner?: string; url?: string } | undefined;
    const tab = snapshot.tabs.find((item) => item.id === input?.id);
    if (op === "state" || op === "open") return snapshot;
    if (op === "still") return still;
    if (op === "create") {
      const id = `new-${++serial}`;
      snapshot.tabs.push({ id, owner: (input?.owner ?? "mine"), title: "", url: (input?.url ?? ""), favicon: "", status: "idle", canBack: false, canForward: false }); snapshot.activeId = id;
    }
    if (op === "close") { snapshot.tabs = snapshot.tabs.filter((item) => item.id !== input?.id); snapshot.activeId = snapshot.tabs.at(-1)?.id ?? null; }
    if (op === "activate") snapshot.activeId = input?.id ?? null;
    if (op === "navigate" && tab) { tab.url = input!.value!; tab.title = "Navigated fixture"; }
    if (op === "reload" && tab) tab.status = "idle";
    if (op === "move") {
      const item = snapshot.tabs.find((entry) => entry.id === input?.tabId)!;
      snapshot.tabs = snapshot.tabs.filter((entry) => entry !== item); snapshot.tabs.splice(input?.index ?? 0, 0, item);
    }
    publish(); return undefined;
  },
};
function FixtureWorkspace() {
  const view = useButlerStore((state) => state.view);
  return mode === "output" && view.kind !== "browser" ? <OutputFrame outputId={"a".repeat(64)} title="Fixture output" /> : <BrowserArea />;
}
createRoot(document.getElementById("root")!).render(
  <AdaptiveShell theme={{ appearance: theme }} leftOpen={true} rightOpen={false} chromeEnvironment="electron">
    <AdaptiveShellSidebar open={true}><BrowserEntry /></AdaptiveShellSidebar>
    <AdaptiveShellWorkspace>
      <Titlebar />
      <Stack fill gap="none"><Stack gap="none"><Dialog><DialogTrigger asChild><Button>Overlay</Button></DialogTrigger>
        <DialogContent><DialogTitle>Fixture dialog</DialogTitle></DialogContent></Dialog></Stack>
      <FixtureWorkspace /></Stack>
    </AdaptiveShellWorkspace>
  </AdaptiveShell>,
);
