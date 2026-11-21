import * as SecureStore from "expo-secure-store";
import { createPairingStore } from "./pairings";

const OPTIONS = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
export const pairingStore = createPairingStore({
  get: k => SecureStore.getItemAsync(k, OPTIONS),
  set: (k, v) => SecureStore.setItemAsync(k, v, OPTIONS),
  remove: k => SecureStore.deleteItemAsync(k, OPTIONS),
});
