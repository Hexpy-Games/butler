import { useEffect, useRef, useState } from "react";
import { apiErrorCode } from "@/app/api.ts";
import { keyCheckFailure, keySaveFailure, saveApiKey, verifyApiKey, type KeyCheckFailure } from "@/app/setupConnection.ts";

/** Pause after the last keystroke or paste before checking the key. */
export const KEY_VERIFY_DEBOUNCE_MS = 400;
/** Shorter input is still being typed, not a key. */
export const MIN_KEY_LENGTH = 8;

/** `saved`: stored, but the service has no model list to check the key against. */
export type KeyStatus = "idle" | "checking" | "valid" | "saved" | KeyCheckFailure;

/** Failures a second try can fix without a new key. */
export const RETRYABLE_KEY_FAILURES: readonly KeyStatus[] = ["network", "ratelimited", "unavailable", "savefailed"];

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
      const check = await verifyApiKey(providerId, key);
      if (id !== sequence.current) return;
      // The same key again reuses the saved credential (`created: false`); its id works the same.
      const credential = await saveApiKey(providerId, key).catch((error: unknown) => {
        throw Object.assign(new Error("key_save_failed"), { saveFailure: keySaveFailure(apiErrorCode(error)) });
      });
      if (id !== sequence.current) return;
      setStatus(check.verified ? "valid" : "saved");
      verified.current(credential.id);
    } catch (error) {
      if (id !== sequence.current) return;
      const saveFailure = (error as { saveFailure?: KeyCheckFailure }).saveFailure;
      setStatus(saveFailure ?? keyCheckFailure(apiErrorCode(error)));
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

  /** Checks the same key again (after a network, rate or service failure). */
  function retry(): void {
    const key = value.trim();
    if (key.length < MIN_KEY_LENGTH) return;
    clearTimeout(timer.current);
    void check(++sequence.current, key);
  }

  return { value, status, change, retry };
}
