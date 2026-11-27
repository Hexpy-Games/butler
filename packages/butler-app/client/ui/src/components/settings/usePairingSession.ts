import { useEffect, useRef, useState } from "react";
import { appCopy } from "@/app/copy.ts";
import { notifyError } from "@/app/notifications.ts";
import { pairedDevicesChanged } from "@/app/securityDeviceEvents.ts";
import { decidePairing, getPairingStatus, issuePairingCode, type PairingCode, type PairingStatus } from "./securityApi";

/** A code lives only in this mounted panel, never in persisted settings. */
export function usePairingSession(enabled: boolean) {
  const [code, setCode] = useState<PairingCode | null>(null);
  const [busy, setBusy] = useState(false);
  const [paired, setPaired] = useState(false);
  const [invalidated, setInvalidated] = useState(false);
  const [request, setRequest] = useState<PairingStatus["request"]>(null);
  const [rejected, setRejected] = useState(false);
  const [remaining, setRemaining] = useState(0);
  const mounted = useRef(false);
  const issuing = useRef(false);
  useEffect(() => {
    if (!enabled) {
      setCode(null);
      setBusy(false);
      setPaired(false);
      setInvalidated(false);
      setRequest(null);
      setRejected(false);
      setRemaining(0);
      return;
    }
    mounted.current = true;
    return () => { mounted.current = false; };
  }, [enabled]);

  async function issue() {
    if (issuing.current) return;
    issuing.current = true;
    setBusy(true);
    setPaired(false);
    setInvalidated(false);
    setRejected(false);
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

  async function decide(allow: boolean) {
    if (!code) return;
    setBusy(true);
    try {
      await decidePairing(code.id, allow);
    } catch (error) {
      if (mounted.current) notifyError(error, appCopy.settings.security.pairingFailed);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  useEffect(() => {
    if (!enabled || !code) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const fail = (error: unknown) => {
      setCode(null);
      setRequest(null);
      notifyError(error, appCopy.settings.security.pairingFailed);
    };
    async function poll() {
      try {
        const status = await getPairingStatus();
        if (cancelled) return;
        if (status?.id === code!.id && (status.status === "pending" || status.status === "approved")) {
          if (status.status === "pending") setRequest(status.request);
          timer = setTimeout(() => void poll(), 1000);
          return;
        }
        if (status?.id === code!.id && status.status === "paired") {
          setCode(null);
          setRequest(null);
          setPaired(true);
          pairedDevicesChanged();
          return;
        }
        if (!status || status.id !== code!.id || status.status !== "active") {
          // Hide the expired/invalid code before waiting for its replacement.
          setBusy(true);
          setInvalidated(false);
          setRejected(false);
          try {
            const next = await issuePairingCode();
            if (cancelled) return;
            setInvalidated(Boolean(status?.invalidated_by));
            setRejected(status?.id === code!.id && status.status === "rejected");
            setRequest(null);
            setCode(next);
            setRemaining(next.expires_in);
          } finally {
            if (!cancelled) setBusy(false);
          }
        } else {
          setRemaining(status.expires_in);
          timer = setTimeout(() => void poll(), 1000);
        }
      } catch (error) {
        if (!cancelled) fail(error);
      }
    }
    timer = setTimeout(() => void poll(), 1000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [enabled, code]);
  return { code, busy, paired, invalidated, request, rejected, remaining, issue, decide };
}
