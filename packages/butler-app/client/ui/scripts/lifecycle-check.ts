import { buildLifecycleAssets } from "./lifecycle-window-build";
import { checkLifecycleStills } from "./generate-lifecycle-stills";
await buildLifecycleAssets(true);
checkLifecycleStills();
console.log("Lifecycle window and still inputs are current.");
