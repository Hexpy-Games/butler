import { toast } from "sonner";

interface NotifyOptions {
  id?: string;
  title?: string;
}

interface NotifyStatusOptions {
  id?: string;
  tone?: "ok" | "muted" | "error";
}

export function safeErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

export function notifyLoading(message: string, options: NotifyOptions = {}): void {
  toast.loading(options.title ?? message, {
    id: options.id,
  });
}

export function notifyStatus(
  message: string,
  options: NotifyStatusOptions = {},
): void {
  if (options.tone === "ok") {
    toast.success(message, { id: options.id });
    return;
  }
  if (options.tone === "error") {
    toast.error(message, { id: options.id });
    return;
  }
  toast.message(message, { id: options.id });
}

export function notifyError(error: unknown, fallback: string, options: NotifyOptions = {}): void {
  toast.error(options.title ?? fallback, {
    id: options.id,
    description: safeErrorMessage(error, fallback),
  });
}
