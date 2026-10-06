import { buildLifecycleAssets } from "./lifecycle-window-build";
// Reuse the captured renderer; each asset is decoded once, without image warm-up.
await buildLifecycleAssets(true, true);
console.log("Lifecycle window and still inputs are current.");
