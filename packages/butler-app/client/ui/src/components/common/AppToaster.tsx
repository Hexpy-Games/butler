import { Toaster } from "sonner";
import { toastClassNames } from "@/butler-ds";

export function AppToaster() {
  return (
    <Toaster
      closeButton
      gap={8}
      mobileOffset={{ top: "var(--titlebar-safe-area-top)" }}
      offset={{ top: "var(--titlebar-safe-area-top)" }}
      position="top-center"
      richColors={false}
      toastOptions={{
        classNames: toastClassNames,
      }}
    />
  );
}
