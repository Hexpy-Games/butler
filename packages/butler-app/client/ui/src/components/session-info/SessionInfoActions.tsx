import { leaveCanonEditor } from "@/app/canonEditGuard.ts";
import { useState } from "react";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import { AppleReminder, Blocks, ButtonContainer, Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, IconButton, Presence, ScrollArea } from "@/butler-ds";
import { TasksPanel } from "../inspector/TasksPanel.tsx";
import { useSessionSectionsModel } from "./useSessionSectionsModel.ts";

export function SessionInfoActions() {
  useAppLocale();
  const sessionId = useButlerStore(state => state.activeChatId);
  const open = useButlerStore(state => state.sessionInfoOpen);
  const graphEnabled = useButlerStore(state => state.taskGraphEnabled);
  const [graphOpen, setGraphOpen] = useState(false);
  const { ids, asks } = useSessionSectionsModel();
  const indicator = Boolean(asks?.open_count);
  const c = appCopy.sessionInfo;
  return <ButtonContainer size="icon-sm">
    {graphEnabled && <Dialog open={graphOpen} onOpenChange={next => { void (async () => { if (!next || await leaveCanonEditor()) setGraphOpen(next); })(); }}>
      <DialogTrigger asChild><IconButton label={appCopy.taskGraph.title}><Blocks size="md" /></IconButton></DialogTrigger>
      <DialogContent size="full" height="full" layout="scroll-body" closeLabel={appCopy.common.close}>
        <DialogHeader><DialogTitle>{appCopy.taskGraph.title}</DialogTitle></DialogHeader>
        <ScrollArea fill>{graphOpen && <TasksPanel key={sessionId} hideHeading />}</ScrollArea>
      </DialogContent>
    </Dialog>}
    <Presence present={ids.length > 0} motion="fade"><IconButton label={c.title} aria-label={indicator ? c.waitingLabel : c.title} pane="aside" pressed={open}
      tone={open ? "butler" : "default"} indicator={indicator} data-test-class="session-info-toggle" onClick={async () => {
        if (await leaveCanonEditor()) useButlerStore.setState(state => ({ sessionInfoOpen: !state.sessionInfoOpen }));
      }}>
      <AppleReminder size="md" />
    </IconButton></Presence>
  </ButtonContainer>;
}
