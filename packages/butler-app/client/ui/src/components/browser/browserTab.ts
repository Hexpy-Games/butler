import type { PageDialog } from "./BrowserDialog";

export interface BrowserTab {
  popup?: { id: string; url: string }; dialog?: PageDialog | null; blockedPopup?: { url: string; site: string; reason: string } | null; opener?: string;
  privacyFrozen?: boolean;
  id: string; owner: string; url: string; title: string; favicon: string;
  preview?: string; picking?: boolean; selectionCount?: number;
  stills?: boolean; agent?: boolean; driven?: boolean; profile?: "signed_out" | "signed_in"; epoch?: number; holder?: "agent" | "user"; sticky?: boolean; waiting?: boolean; busy?: boolean; inUse?: boolean;
  /** You took the tab over while a Butler turn held it; clears when that turn ends. */
  paused?: boolean;
  /** When Butler last worked in this tab (ms since epoch); absent if it never has. */
  agentAt?: number;
  status: "idle" | "loading" | "crashed"; canBack: boolean; canForward: boolean;
  /** A sign-in step only the user can do (mfa, passkey, captcha, secure_keypad, unknown_form). */
  signinStep?: string;
  payStep?: string;
  /** "로그인 저장" after a takeover sign-in; never carries the password. */
  saveOffer?: { username: string; host: string };
  /** The page's layout size while a phone views the tab; absent otherwise. */
  phoneViewport?: { width: number; height: number };
}
