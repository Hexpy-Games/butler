import { useEffect, useState } from "react";
import { getButlerAccount } from "@/app/butlerAccount";

// The page shows when the route answers, or fails on the server side (the Butler service is unreachable).
// Any client error, 404 (off) or 403 (not this computer's admin) included, hides it.
function serverSide(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" && status >= 500;
}

export function useButlerAccountAvailable(): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void getButlerAccount().then(
      () => { if (!cancelled) setAvailable(true); },
      (error) => { if (!cancelled) setAvailable(serverSide(error)); },
    );
    return () => { cancelled = true; };
  }, []);
  return available;
}
