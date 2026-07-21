import type { TurnExecutionSupervisor } from "./contracts.ts";

type TurnControl = {
  stopped: boolean;
  allowFinalizing: boolean;
  controller?: AbortController;
  executionFence?: number;
};

export function createTurnExecutionSupervisor(): TurnExecutionSupervisor {
  const controls = new Map<string, TurnControl>();

  return {
    enter(input) {
      const control = controls.get(input.turnId) ?? {
        stopped: false,
        allowFinalizing: false,
      };
      const deliveryAllowed = control.allowFinalizing &&
        input.semanticState === "delivery_committed";
      if (control.stopped && !deliveryAllowed) throw fenced(input.turnId);
      const controller = new AbortController();
      control.controller = controller;
      control.executionFence = input.executionFence;
      controls.set(input.turnId, control);
      return {
        signal: controller.signal,
        assertActive() {
          const current = controls.get(input.turnId);
          if (!current || current.controller !== controller || controller.signal.aborted) {
            throw fenced(input.turnId);
          }
        },
        close() {
          const current = controls.get(input.turnId);
          if (current?.controller === controller) current.controller = undefined;
        },
      };
    },
    installStop(turnId) {
      const control = controls.get(turnId) ?? {
        stopped: false,
        allowFinalizing: false,
      };
      control.stopped = true;
      control.allowFinalizing = false;
      control.controller?.abort();
      controls.set(turnId, control);
    },
    allowFinalizing(turnId) {
      const control = controls.get(turnId);
      if (control) control.allowFinalizing = true;
    },
  };
}

function fenced(turnId: string): Error {
  return new Error(`BTCC Turn execution is fenced: ${turnId}`);
}
