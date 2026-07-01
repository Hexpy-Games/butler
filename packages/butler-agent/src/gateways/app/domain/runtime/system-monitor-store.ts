import { readUsageMonitor } from "../../../../operations/metrics/usage-monitor.ts";
import { systemEventsForButlerData } from "./system-events-read-model.ts";
import { paginationInput } from "../sessions/session-read-model.ts";
import type { SystemEventListView, UsageMonitorView } from "../../interface/protocol/app-protocol.ts";

export class AppSystemMonitorStore {
  constructor(private readonly butlerData: string) {}

  listSystemEvents(
    options: { limit?: number; offset?: number } = {},
  ): SystemEventListView {
    const page = paginationInput(options);
    const events = systemEventsForButlerData(this.butlerData);
    return {
      events: events.slice(page.offset, page.offset + page.limit),
      pagination: {
        ...page,
        total: events.length,
        has_more: page.offset + page.limit < events.length,
      },
      generated_at: new Date().toISOString(),
      raw_text_included: false,
    };
  }

  getUsageMonitor(
    options: { sessionId?: string; sinceTs?: number | null } = {},
  ): UsageMonitorView {
    return {
      ...readUsageMonitor({
        butlerData: this.butlerData,
        sessionId: options.sessionId,
        sinceTs: options.sinceTs ?? null,
      }),
      generated_at: new Date().toISOString(),
      raw_text_included: false,
    };
  }
}
