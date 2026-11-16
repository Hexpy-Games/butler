import { useEffect, useState } from "react";
import { getButlerAccount } from "@/app/butlerAccount";
import { isMissingRoute } from "@/app/setupConnection";

export function useButlerAccountAvailable(): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void getButlerAccount().then(
      () => { if (!cancelled) setAvailable(true); },
      (error) => { if (!cancelled) setAvailable(!isMissingRoute(error)); },
    );
    return () => { cancelled = true; };
  }, []);
  return available;
}
