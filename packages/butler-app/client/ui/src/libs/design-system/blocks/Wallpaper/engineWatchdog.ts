import { HEALTHY_WATCHDOG, frameWatchdogRetryMs, retryFrameWatchdog, stepFrameWatchdog } from "./scheduler";

export interface EngineWatchdog {
  /** Runs one animated render and times it; true when the scene just degraded. */
  time(render: () => void): boolean;
  /** A new scene: healthy again, retries forgotten. */
  reset(): void;
  dispose(): void;
}

/**
 * The engine's frame-time watchdog. It times the render itself (a main-thread
 * stall elsewhere stretches frame gaps, not this); a sustained run of slow
 * renders degrades (`onDegrade`, `first` once per scene), and after a quiet
 * period that grows per retry it tries animating again (`onRetry`).
 */
export function createEngineWatchdog({ onDegrade, onRetry }: { onDegrade: (first: boolean) => void; onRetry: () => void }): EngineWatchdog {
  let watchdog = HEALTHY_WATCHDOG;
  let timer = 0;
  let reported = false;
  const stop = () => {
    window.clearTimeout(timer);
    timer = 0;
  };
  return {
    time(render) {
      const start = performance.now();
      render();
      watchdog = stepFrameWatchdog(watchdog, performance.now() - start);
      if (!watchdog.degraded) return false;
      stop();
      timer = window.setTimeout(() => {
        timer = 0;
        watchdog = retryFrameWatchdog(watchdog);
        onRetry();
      }, frameWatchdogRetryMs(watchdog));
      onDegrade(!reported);
      reported = true;
      return true;
    },
    reset() {
      stop();
      watchdog = HEALTHY_WATCHDOG;
      reported = false;
    },
    dispose: stop,
  };
}
