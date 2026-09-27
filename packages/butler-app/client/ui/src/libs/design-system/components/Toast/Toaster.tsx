import { Toaster as SonnerToaster, type ToasterProps as SonnerToasterProps } from "sonner";
import { toastClassNames } from "./Toast";

export interface ToasterProps {
  /** Distance from the window edge (the app passes the titlebar safe area). */
  offset?: SonnerToasterProps["offset"];
  mobileOffset?: SonnerToasterProps["mobileOffset"];
}

/**
 * Butler's one toast region: sonner at the top center with a close button,
 * restyled by DS tokens (surface, tones, motion) in both themes. Raise
 * toasts with sonner's `toast()` through the app notification helpers.
 */
export function Toaster({ offset, mobileOffset }: ToasterProps) {
  return (
    <SonnerToaster
      closeButton
      gap={8}
      offset={offset}
      mobileOffset={mobileOffset}
      position="top-center"
      richColors={false}
      toastOptions={{ classNames: toastClassNames }}
    />
  );
}
