import { useEffect, useRef, useState } from "react";
import { cancelSignIn, openSignInPage, signInStatus, startSignIn, type SignInSession } from "@/app/setupSignIn.ts";
import type { OpenAIOAuthLoginResult } from "@/components/settings/modelManagementApi";

export const SIGN_IN_POLL_MS = 1000;
/** A sign-in with no answer for this long reads as cancelled. */
export const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;

export type SignInPhase = "idle" | "starting" | "waiting" | "cancelled" | "failed";

const SIGNED_IN = new Set<OpenAIOAuthLoginResult["status"]>(["completed", "profile_exists"]);
const OPEN = new Set<OpenAIOAuthLoginResult["status"]>(["starting", "pending"]);

/**
 * ChatGPT sign-in. Starting it opens the system browser (the app opens the
 * agent flow's `auth_url`; the desktop fallback opens it itself); the app
 * then waits for the browser to finish, with Cancel and "Copy link" as the
 * ways out.
 */
export function useSignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [phase, setPhase] = useState<SignInPhase>("idle");
  const [session, setSession] = useState<SignInSession | null>(null);
  const [copied, setCopied] = useState(false);
  const run = useRef(0);
  const polling = useRef(false);
  const opened = useRef<string | null>(null);
  const signedIn = useRef(onSignedIn);
  signedIn.current = onSignedIn;

  function settle(id: number, current: SignInSession, result: OpenAIOAuthLoginResult): void {
    if (id !== run.current) return;
    const next = { ...current, view: { ...current.view, ...result } };
    setSession(next);
    if (next.backend === "agent" && next.view.auth_url && opened.current !== next.view.auth_url) {
      opened.current = next.view.auth_url;
      openSignInPage(next.view.auth_url);
    }
    if (SIGNED_IN.has(result.status)) {
      run.current += 1;
      setPhase("idle");
      signedIn.current();
    } else if (result.status === "cancelled" || result.status === "failed") {
      setPhase(result.status);
    } else if (OPEN.has(result.status)) {
      setPhase("waiting");
    }
  }

  async function start(): Promise<void> {
    const id = ++run.current;
    setPhase("starting");
    setCopied(false);
    opened.current = null;
    try {
      const started = await startSignIn();
      settle(id, started, started.view);
    } catch {
      if (id === run.current) setPhase("failed");
    }
  }

  useEffect(() => {
    if (phase !== "waiting" || !session) return undefined;
    const id = run.current;
    const current = session;
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - startedAt > SIGN_IN_TIMEOUT_MS) {
        void cancel();
        return;
      }
      if (polling.current) return;
      polling.current = true;
      signInStatus(current)
        .then((result) => settle(id, current, result))
        .catch(() => undefined)
        .finally(() => {
          polling.current = false;
        });
    }, SIGN_IN_POLL_MS);
    return () => clearInterval(timer);
    // Poll once per waiting flow; later views of the same flow do not restart it.
  }, [phase, session?.view.flow_id]);

  async function cancel(): Promise<void> {
    run.current += 1;
    setPhase("cancelled");
    if (!session) return;
    const result = await cancelSignIn(session).catch(() => undefined);
    // A cancel that lands after the code exchange answers `completed`: the sign-in went through.
    if (result && SIGNED_IN.has(result.status)) {
      setPhase("idle");
      signedIn.current();
    }
  }

  async function copyLink(): Promise<void> {
    const url = session?.view.auth_url;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
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

  return { phase, copied, canCopyLink: Boolean(session?.view.auth_url), start, cancel, copyLink, leave };
}
