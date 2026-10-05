import { AppConfirmationDialog } from "./AppConfirmationDialog.tsx";
import { AppUpdateDialog } from "./AppUpdateDialog.tsx";

/** Global decisions remain available while navigating or reopening Settings. */
export function AppDialogs() {
  return <><AppConfirmationDialog /><AppUpdateDialog /></>;
}
