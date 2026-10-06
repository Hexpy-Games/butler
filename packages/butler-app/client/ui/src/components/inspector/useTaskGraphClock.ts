import { useEffect, useState } from "react";

/** A graph owns one clock, and releases it as soon as its view or work is idle. */
export function useTaskGraphClock(running: boolean, visible: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running || !visible) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const sync = () => {
      clearInterval(timer);
      timer = undefined;
      if (document.visibilityState !== "visible") return;
      setNow(Date.now());
      timer = setInterval(() => setNow(Date.now()), 1000);
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", sync); };
  }, [running, visible]);
  return now;
}
