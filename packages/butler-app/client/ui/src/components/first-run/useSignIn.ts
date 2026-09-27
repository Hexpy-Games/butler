import { useEffect, useRef, useState } from "react";
import { cancelSignInFlow } from "@/app/setupConnection.ts";
import {
  getOpenAIOAuthLoginStatus,
  startOpenAIOAuthLogin,
  type OpenAIOAuthLoginResult,
} from "@/components/settings/modelManagementApi";

export const SIGN_IN_POLL_MS = 1000;
/** A sign-in with no answer for this long reads as cancelled. */
export const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;

export type SignInPhase = "idle" | "starting" | "waiting" | "cancelled" | "failed";

const SIGNED_IN = new Set<OpenAIOAuthLoginResult["status"]>(["completed", "profile_exists"]);

/**
 * ChatGPT sign-in. Starting it opens the system browser (the desktop app does
 * that as soon as the sign-in link exists); the app then waits for the
 * browser to finish, with Cancel and "Copy link" as the ways out.
 */
export function useSignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [phase, setPhase] = useState<SignInPhase>("idle");
  const [login, setLogin] = useState<OpenAIOAuthLoginResult | null>(null);
  const [copied, setCopied] = useState(false);
  const run = useRef(0);
  const polling = useRef(false);
  const signedIn = useRef(onSignedIn);
  signedIn.current = onSignedIn;

  function settle(id: number, result: OpenAIOAuthLoginResult): void {
    if (id !== run.current) return;
    setLogin((current) => ({ ...current, ...result }));
    if (SIGNED_IN.has(result.status)) {
      run.current += 1;
      setPhase("idle");
      signedIn.current();
    } else if (result.status === "cancelled" || result.status === "failed") {
      setPhase(result.status);
    }
  }

  async function start(): Promise<void> {
    const id = ++run.current;
    setPhase("starting");
    setCopied(false);
    try {
      const result = await startOpenAIOAuthLogin();
      if (id !== run.current) return;
      setLogin(result);
      if (result.status === "pending" || result.status === "starting") setPhase("waiting");
      else settle(id, result);
    } catch {
      if (id === run.current) setPhase("failed");
    }
  }

  useEffect(() => {
    if (phase !== "waiting") return undefined;
    const id = run.current;
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - startedAt > SIGN_IN_TIMEOUT_MS) {
        void cancel();
        return;
      }
      if (polling.current) return;
      polling.current = true;
      getOpenAIOAuthLoginStatus()
        .then((result) => settle(id, result))
        .catch(() => undefined)
        .finally(() => {
          polling.current = false;
        });
    }, SIGN_IN_POLL_MS);
    return () => clearInterval(timer);
  }, [phase]);

  async function cancel(): Promise<void> {
    run.current += 1;
    setPhase("cancelled");
    const flowId = login?.flow_id;
    if (flowId) await cancelSignInFlow(flowId).catch(() => undefined);
  }

  async function copyLink(): Promise<void> {
    if (!login?.auth_url) return;
    try {
      await navigator.clipboard.writeText(login.auth_url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  /** Leave the sign-in screen; a pending sign-in is cancelled. */
  function leave(): void {
    if (phase === "waiting" || phase === "starting") void cancel();
    run.current += 1;
    setPhase("idle");
  }

  return { phase, copied, canCopyLink: Boolean(login?.auth_url), start, cancel, copyLink, leave };
}
