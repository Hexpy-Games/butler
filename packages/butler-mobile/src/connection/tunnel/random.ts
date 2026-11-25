import { getRandomBytes } from "expo-crypto";
export const randomBytes = (count: number): Uint8Array => getRandomBytes(count);
