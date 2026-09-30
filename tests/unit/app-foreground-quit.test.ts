import { describe, expect, test } from "bun:test";
import {
  APP_FOREGROUND_QUIT_COPY,
  classifyAppForegroundActiveWork,
  confirmAppForegroundQuit,
} from "../../packages/butler-app/client/electron/app-foreground-quit.mjs";

describe("App foreground quit", () => {
  test("classifies active turns, workers, and queued work", () => {
    expect(classifyAppForegroundActiveWork({
      navigation: {
        chats: [{
          active_turn_state: "streaming",
          active_turn_id: "turn-active",
        }],
      },
      workerActivity: {
        workers: [{ status: "running", worker_id: "worker-active" }],
      },
      queues: [{ items: [{ id: "queued" }] }],
    })).toEqual({
      classification: "active_work_detected",
      reasons: ["active_turn", "active_worker", "queued_work"],
      turn_ids: ["turn-active"],
      worker_ids: ["worker-active"],
      raw_text_included: false,
    });
  });

  test("fails safe when active work cannot be read", () => {
    expect(classifyAppForegroundActiveWork({ readFailed: true }).classification)
      .toBe("active_work_unknown");
  });

  test("does not prompt without active work", async () => {
    let prompts = 0;
    expect(await confirmAppForegroundQuit({
      snapshot: classifyAppForegroundActiveWork({ navigation: { chats: [] } }),
      showMessageBox: async () => { prompts += 1; return { response: 0 }; },
    })).toBeTrue();
    expect(prompts).toBe(0);
  });

  // test-category: pure-logic
  test("uses destructive intent and honors Cancel", async () => {
    let options: Record<string, unknown> | null = null;
    const confirmed = await confirmAppForegroundQuit({
      snapshot: classifyAppForegroundActiveWork({ readFailed: true }),
      showMessageBox: async (input: Record<string, unknown>) => {
        options = input;
        return { response: 0 };
      },
    });
    expect(confirmed).toBeFalse();
    expect(APP_FOREGROUND_QUIT_COPY).toContain("schedules");
    expect(APP_FOREGROUND_QUIT_COPY).not.toContain("자동화");
    expect(options).toMatchObject({
      message: APP_FOREGROUND_QUIT_COPY,
      buttons: ["Cancel", "Quit Butler"],
      cancelId: 0,
    });
    await confirmAppForegroundQuit({
      language: "ko",
      snapshot: classifyAppForegroundActiveWork({ readFailed: true }),
      showMessageBox: async (input) => { options = input; return { response: 1 }; },
    });
    expect(options).toMatchObject({
      message: "버틀러를 종료하면 작업과 예약 작업이 중지됩니다.",
      buttons: ["취소", "버틀러 종료"],
    });
  });
});
