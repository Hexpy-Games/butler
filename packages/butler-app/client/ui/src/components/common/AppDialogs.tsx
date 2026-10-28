import { CanonTrustDialog } from "../canon/CanonTrustDialog.tsx";
import { AppConfirmationDialog } from "./AppConfirmationDialog.tsx";
import { AppUpdateDialog } from "./AppUpdateDialog.tsx";

/** Global decisions remain available while navigating or reopening Settings. */
export function AppDialogs({ showCanonTrust = true }: { showCanonTrust?: boolean }) {
  return <>{showCanonTrust && <CanonTrustDialog />}<AppConfirmationDialog /><AppUpdateDialog /></>;
}
