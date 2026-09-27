import { useEffect, useRef, useState } from "react";
import { apiErrorCode } from "@/app/api.ts";
import { keyCheckFailure, saveApiKey, verifyApiKey, type KeyCheckFailure } from "@/app/setupConnection.ts";

/** Pause after the last keystroke or paste before checking the key. */
export const KEY_VERIFY_DEBOUNCE_MS = 400;
/** Shorter input is still being typed, not a key. */
export const MIN_KEY_LENGTH = 8;

export type KeyStatus = "idle" | "checking" | "valid" | KeyCheckFailure;

/**
 * One API key field: checked with the service as soon as it is pasted
 * (`POST /setup/credentials/verify`), then saved (`POST /credentials`, named
 * by the agent). A newer input always wins over an older answer, and a
 * failed key stays in the field.
 */
export function useKeyVerification({ providerId, onVerified }: {
  providerId: string;
  onVerified: (credentialId: string) => void;
}) {
  const [value, setValue] = useState("");
  const [status, setStatus] = useState<KeyStatus>("idle");
  const sequence = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const verified = useRef(onVerified);
  verified.current = onVerified;

  useEffect(() => () => clearTimeout(timer.current), []);

  async function check(id: number, key: string): Promise<void> {
    setStatus("checking");
    try {
      await verifyApiKey(providerId, key);
      if (id !== sequence.current) return;
      const credentialId = await saveApiKey(providerId, key);
      if (id !== sequence.current) return;
      setStatus("valid");
      verified.current(credentialId);
    } catch (error) {
      if (id === sequence.current) setStatus(keyCheckFailure(apiErrorCode(error)));
    }
  }

  function change(next: string): void {
    setValue(next);
    clearTimeout(timer.current);
    const id = ++sequence.current;
    const key = next.trim();
    if (key.length < MIN_KEY_LENGTH) {
      setStatus("idle");
      return;
    }
    timer.current = setTimeout(() => void check(id, key), KEY_VERIFY_DEBOUNCE_MS);
  }

  return { value, status, change };
}
