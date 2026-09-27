import { Toaster } from "@/butler-ds";

export function AppToaster() {
  return (
    <Toaster
      mobileOffset={{ top: "var(--titlebar-safe-area-top)" }}
      offset={{ top: "var(--titlebar-safe-area-top)" }}
    />
  );
}
