import { useState } from "react";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import { AppleReminder, Blocks, ButtonContainer, Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, IconButton, ScrollArea } from "@/butler-ds";
import { TasksPanel } from "../inspector/TasksPanel.tsx";
import { usePendingAsks } from "./usePendingAsks.ts";

export function SessionInfoActions() {
  useAppLocale();
  const sessionId = useButlerStore(state => state.activeChatId);
  const open = useButlerStore(state => state.sessionInfoOpen);
  const graphEnabled = useButlerStore(state => state.taskGraphEnabled);
  const [graphOpen, setGraphOpen] = useState(false);
  const asks = usePendingAsks(sessionId);
  const indicator = Boolean(asks?.open_count);
  const c = appCopy.sessionInfo;
  return <ButtonContainer size="icon-sm">
    {graphEnabled && <Dialog open={graphOpen} onOpenChange={setGraphOpen}>
      <DialogTrigger asChild><IconButton label={appCopy.taskGraph.title}><Blocks size="md" /></IconButton></DialogTrigger>
      <DialogContent size="full" layout="scroll-body" closeLabel={appCopy.common.close}>
        <DialogHeader><DialogTitle>{appCopy.taskGraph.title}</DialogTitle></DialogHeader>
        <ScrollArea fill>{graphOpen && <TasksPanel key={sessionId} hideHeading />}</ScrollArea>
      </DialogContent>
    </Dialog>}
    <IconButton label={c.title} aria-label={indicator ? c.waitingLabel : c.title} pressed={open} indicator={indicator}
      data-test-class="session-info-toggle" onClick={() => useButlerStore.setState({ sessionInfoOpen: !open })}>
      <AppleReminder size="md" />
    </IconButton>
  </ButtonContainer>;
}
