import { useEffect, useRef, useState } from "react";
import { appCopy } from "@/app/copy.ts";
import { notifyError } from "@/app/notifications.ts";
import { pairedDevicesChanged } from "@/app/securityDeviceEvents.ts";
import { getPairingStatus, issuePairingCode, type PairingCode } from "./securityApi";

/** A code lives only in this mounted panel, never in persisted settings. */
export function usePairingSession() {
  const [code, setCode] = useState<PairingCode | null>(null);
  const [busy, setBusy] = useState(false);
  const [paired, setPaired] = useState(false);
  const [invalidated, setInvalidated] = useState(false);
  const [remaining, setRemaining] = useState(0);
  const mounted = useRef(false);
  const issuing = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  async function issue() {
    if (issuing.current) return;
    issuing.current = true;
    setBusy(true);
    setPaired(false);
    setInvalidated(false);
    try {
      const next = await issuePairingCode();
      if (mounted.current) {
        setCode(next);
        setRemaining(next.expires_in);
      }
    } catch (error) {
      if (mounted.current) notifyError(error, appCopy.settings.security.pairingFailed);
    } finally {
      issuing.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  useEffect(() => {
    if (!code) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const fail = (error: unknown) => {
      setCode(null);
      notifyError(error, appCopy.settings.security.pairingFailed);
    };
    async function poll() {
      try {
        const status = await getPairingStatus();
        if (cancelled) return;
        if (status?.id === code!.id && status.status === "paired") {
          setCode(null);
          setPaired(true);
          pairedDevicesChanged();
          return;
        }
        if (!status || status.id !== code!.id || status.status !== "active") {
          // Hide the expired/invalid code before waiting for its replacement.
          setBusy(true);
          const next = await issuePairingCode();
          if (cancelled) return;
          setInvalidated(Boolean(status?.invalidated_by));
          setCode(next);
          setRemaining(next.expires_in);
        } else {
          setRemaining(status.expires_in);
          timer = setTimeout(() => void poll(), 1000);
        }
      } catch (error) {
        if (!cancelled) fail(error);
      } finally {
        if (!cancelled) setBusy(false);
      }
    }
    timer = setTimeout(() => void poll(), 1000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [code]);
  return { code, busy, paired, invalidated, remaining, issue };
}
