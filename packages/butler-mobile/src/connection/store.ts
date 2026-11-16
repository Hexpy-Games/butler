import * as SecureStore from "expo-secure-store";

/** The paired Butler, kept only in the OS keychain/keystore. */
export type SavedConnection = { origin: string; butlerId: string; deviceToken: string };

const KEY = "butler.connection";
const OPTIONS = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

export async function loadConnection(): Promise<SavedConnection | null> {
  const raw = await SecureStore.getItemAsync(KEY, OPTIONS);
  return raw ? (JSON.parse(raw) as SavedConnection) : null;
}

export function saveConnection(connection: SavedConnection): Promise<void> {
  return SecureStore.setItemAsync(KEY, JSON.stringify(connection), OPTIONS);
}

export function clearConnection(): Promise<void> {
  return SecureStore.deleteItemAsync(KEY, OPTIONS);
}
