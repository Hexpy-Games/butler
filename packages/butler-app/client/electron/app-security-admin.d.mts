export const APP_LOCAL_ADMIN_FILE: string[];
export const APP_LOCAL_ADMIN_SCHEMA: string;
export const APP_LOCAL_ADMIN_FIELD: string;
export const APP_LOCAL_ADMIN_MIN_LENGTH: number;
export const APP_ADMIN_HEADER: string;

export type SecurityBridgeRoute =
  | "getSecurity"
  | "revealConnectionCode"
  | "rotateConnectionCode"
  | "updateSecuritySettings";

export type SecurityBridgeResult =
  | { ok: true; data: unknown }
  | {
      ok: false;
      error: { schema: "butler.app.bridge-error.v1"; code: string; status?: number };
    };

export function isSecuritySenderOrigin(
  origin: unknown,
  options: { appOrigin: string; devOrigin?: string | null },
): boolean;
export function appLocalAdminPath(butlerData: string): string;
export function readAppLocalAdmin(input: { butlerData: string }): string | null;
export function requestSecurityRoute(
  input: unknown,
  options: {
    ensureReady: () => Promise<unknown>;
    fetch: (url: URL, init: RequestInit) => Promise<Response>;
    serverUrl: string;
    authHeaders: () => Record<string, string> | Promise<Record<string, string>>;
    adminCredential: string | null;
    onRotated?: () => unknown;
  },
): Promise<SecurityBridgeResult>;
