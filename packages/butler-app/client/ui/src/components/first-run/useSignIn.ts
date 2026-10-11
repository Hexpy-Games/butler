import { useEffect, useRef, useState, type RefObject } from "react";
import { cancelSignIn, openSignInPage, signInStatus, startSignIn, type SignInSession } from "@/app/setupSignIn.ts";
import type { OpenAIOAuthLoginResult } from "@/components/settings/modelManagementApi";

export const SIGN_IN_POLL_MS = 1000;
/** A sign-in with no answer for this long times out. */
export const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;

export type SignInPhase = "idle" | "starting" | "waiting" | "cancelled" | "timedout" | "failed";

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
    setSession(null);
    setCopied(false);
    opened.current = null;
    try {
      const started = await startSignIn();
      settle(id, started, started.view);
    } catch {
      if (id === run.current) setPhase("failed");
    }
  }

  useSignInPolling({ phase, session, run, polling, settle, cancel });

  async function cancel(reason: "cancelled" | "timedout" = "cancelled"): Promise<void> {
    const id = ++run.current;
    setPhase(reason);
    if (!session) return;
    const result = await cancelSignIn(session).catch(() => undefined);
    // A cancel that lands after the code exchange answers `completed`: the sign-in went through.
    if (id === run.current && result && SIGNED_IN.has(result.status)) {
      setSession({ ...session, view: { ...session.view, ...result } });
      setPhase("idle");
      signedIn.current();
    }
  }

  /** Leave the sign-in screen; a pending sign-in is cancelled. */
  function leave(): void {
    if (phase === "waiting" || phase === "starting") void cancel();
    run.current += 1;
    setPhase("idle");
  }

  const label = session?.view.label;
  const account = label?.includes("@") ? label : undefined;
  function reopen(): void {
    if (session?.view.auth_url) openSignInPage(session.view.auth_url);
  }
  return { phase, account, copied, canCopyLink: Boolean(session?.view.auth_url), start, cancel: () => cancel(), copyLink: () => copySignInLink(session?.view.auth_url, setCopied), reopen, leave };
}

/** Poll only the active flow; a timeout cancels its listener and has its own screen state. */
function useSignInPolling({ phase, session, run, polling, settle, cancel }: {
  phase: SignInPhase;
  session: SignInSession | null;
  run: RefObject<number>;
  polling: RefObject<boolean>;
  settle: (id: number, current: SignInSession, result: OpenAIOAuthLoginResult) => void;
  cancel: (reason: "timedout") => Promise<void>;
}) {
  useEffect(() => {
    if (phase !== "waiting" || !session) return undefined;
    const id = run.current;
    const current = session;
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - startedAt > SIGN_IN_TIMEOUT_MS) {
        void cancel("timedout");
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

}

async function copySignInLink(url: string | undefined, setCopied: (copied: boolean) => void): Promise<void> {
  if (!url) return;
  try {
    await navigator.clipboard.writeText(url);
    setCopied(true);
  } catch {
    setCopied(false);
  }
}
