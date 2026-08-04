/// <reference types="bun" />

import { expect, test } from "bun:test";
import type { TimelineEvent } from "@/app/types.ts";
import {
  eventSessionId,
  isSessionViewRefreshEvent,
} from "./liveSessionReconciliation.ts";

const ACTIVE_SESSION_ID = "session-live-events";
const OTHER_SESSION_ID = "session-other";

const eventCases: Array<{
  name: string;
  event: TimelineEvent;
  refresh: boolean;
  sessionId?: string;
}> = [
  {
    name: "turn.progress",
    event: {
      type: "turn.progress",
      payload: { session_id: ACTIVE_SESSION_ID, state: "running" },
    },
    refresh: true,
    sessionId: ACTIVE_SESSION_ID,
  },
  {
    name: "turn.progress nested type",
    event: {
      type: "turn.progress.step",
      payload: { session_id: ACTIVE_SESSION_ID, turn_id: "turn-1" },
    },
    refresh: true,
    sessionId: ACTIVE_SESSION_ID,
  },
  {
    name: "agent.turn_event.progress",
    event: {
      type: "agent.turn_event.progress",
      payload: {
        session_id: ACTIVE_SESSION_ID,
        turn_id: "turn-1",
        row: {
          id: "progress-1",
          kind: "work.block",
          state: "running",
          safe_label: "Working",
        },
        event_id: "event-1",
      },
    },
    refresh: true,
    sessionId: ACTIVE_SESSION_ID,
  },
  {
    name: "progress.summary",
    event: {
      type: "progress.summary",
      payload: {
        session_id: ACTIVE_SESSION_ID,
        turn_id: "turn-1",
        row: {
          id: "progress-1",
          state: "running",
          safe_label: "Working",
        },
      },
    },
    refresh: true,
    sessionId: ACTIVE_SESSION_ID,
  },
  {
    name: "agent.turn_event context/skills projection",
    event: {
      type: "agent.turn_event",
      payload: {
        session_id: ACTIVE_SESSION_ID,
        turn_id: "turn-1",
        event: {
          id: "event-1",
          sessionId: ACTIVE_SESSION_ID,
          turnId: "turn-1",
          sessionSequence: 1,
          turnSequence: 1,
          createdAt: "2026-08-04T00:00:00.000Z",
          kind: "tool.completed",
          visibility: "public",
          payload: { context: "updated", skills: ["skill-a"] },
        },
      },
    },
    refresh: true,
    sessionId: ACTIVE_SESSION_ID,
  },
  {
    name: "worker dot event",
    event: {
      type: "worker.app_responder_turn_failed",
      payload: {
        chat_id: ACTIVE_SESSION_ID,
        state: "failed",
        safe_status_label: "Worker failed",
      },
    },
    refresh: true,
    sessionId: ACTIVE_SESSION_ID,
  },
  {
    name: "worker underscore event",
    event: {
      type: "worker_activity_controlled",
      payload: {},
    },
    refresh: true,
  },
  {
    name: "session control",
    event: {
      type: "session.controls_updated",
      payload: { session_id: ACTIVE_SESSION_ID },
    },
    refresh: true,
    sessionId: ACTIVE_SESSION_ID,
  },
  {
    name: "session control nested type",
    event: {
      type: "session.control.updated",
      payload: { session_id: ACTIVE_SESSION_ID },
    },
    refresh: true,
    sessionId: ACTIVE_SESSION_ID,
  },
  {
    name: "session queue",
    event: {
      type: "session_queue.changed",
      payload: { session_id: ACTIVE_SESSION_ID, turn_id: "turn-1" },
    },
    refresh: true,
    sessionId: ACTIVE_SESSION_ID,
  },
  {
    name: "session queue nested type",
    event: {
      type: "session.queue.changed",
      payload: { session_id: ACTIVE_SESSION_ID },
    },
    refresh: true,
    sessionId: ACTIVE_SESSION_ID,
  },
  {
    name: "unrelated event",
    event: {
      type: "automation.run",
      payload: { session_id: ACTIVE_SESSION_ID },
    },
    refresh: false,
    sessionId: ACTIVE_SESSION_ID,
  },
  {
    name: "inactive progress event",
    event: {
      type: "progress.summary",
      payload: { session_id: OTHER_SESSION_ID, turn_id: "turn-2" },
    },
    refresh: true,
    sessionId: OTHER_SESSION_ID,
  },
];

for (const eventCase of eventCases) {
  test(`routes ${eventCase.name} through the session refresh helpers`, () => {
    expect(isSessionViewRefreshEvent(eventCase.event)).toBe(eventCase.refresh);
    expect(eventSessionId(eventCase.event)).toBe(eventCase.sessionId);
  });
}
