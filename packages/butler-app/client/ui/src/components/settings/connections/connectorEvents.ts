import { create } from "zustand";
import type { TimelineEvent } from "@/app/types";

export const useConnectorVersion = create<{ version: number }>(() => ({ version: 0 }));
export function publishConnectorEvent(event: TimelineEvent) {
  if (event.type === "connectors.changed") useConnectorVersion.setState(s => ({ version: s.version + 1 }));
}
