export type Pairing = { origin: string; butlerId: string; deviceId: string; deviceToken: string; computerName?: string };
export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export function isStorableId(id: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(id);
}

export function stringField(value: object, key: string): string | null {
  const field: unknown = Reflect.get(value, key);
  return typeof field === "string" && field !== "" ? field : null;
}

function readPairing(raw: string | null): Pairing | null {
  try {
    if (raw === null) return null;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const origin = stringField(value, "origin");
    const butlerId = stringField(value, "butlerId");
    const deviceId = stringField(value, "deviceId");
    const deviceToken = stringField(value, "deviceToken");
    const computerName = stringField(value, "computerName");
    return origin && butlerId && deviceId && deviceToken ? { origin, butlerId, deviceId, deviceToken, ...(computerName ? { computerName } : {}) } : null;
  } catch {
    return null;
  }
}

const ACTIVE = "butler.active";
const pairingKey = (id: string) => "butler.pairing." + id;

export function createPairingStore(kv: KeyValueStore) {
  return {
    async save(p: Pairing): Promise<void> {
      await kv.set(pairingKey(p.butlerId), JSON.stringify(p));
      await kv.set(ACTIVE, p.butlerId);
    },
    async loadActive(): Promise<Pairing | null> {
      const id = await kv.get(ACTIVE);
      if (!id || !isStorableId(id)) return null;
      const pairing = readPairing(await kv.get(pairingKey(id)));
      return pairing?.butlerId === id ? pairing : null;
    },
    async clear(butlerId: string): Promise<void> {
      await kv.remove(pairingKey(butlerId));
      if (await kv.get(ACTIVE) === butlerId) await kv.remove(ACTIVE);
    },
  };
}

export type PairingStore = ReturnType<typeof createPairingStore>;
