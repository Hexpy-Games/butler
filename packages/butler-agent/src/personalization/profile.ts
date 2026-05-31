import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface PersonalizationProfile {
  butler_nickname: string;
  principal_name: string;
  preferred_address: string;
  updated_at: string | null;
}

export interface PersonalizationProfileUpdate {
  butler_nickname?: string;
  principal_name?: string;
  preferred_address?: string;
}

export const PERSONALIZATION_PROFILE_STORAGE_LABEL = "personalization/profile.json";

const PROFILE_TEXT_LIMIT = 256;

const EMPTY_PROFILE: PersonalizationProfile = {
  butler_nickname: "",
  principal_name: "",
  preferred_address: "",
  updated_at: null,
};

export function personalizationProfilePath(butlerData: string): string {
  return join(butlerData, PERSONALIZATION_PROFILE_STORAGE_LABEL);
}

export function readPersonalizationProfile(butlerData: string): PersonalizationProfile {
  const path = personalizationProfilePath(butlerData);
  if (!existsSync(path)) return { ...EMPTY_PROFILE };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<PersonalizationProfile>;
    return normalizeProfile(raw);
  } catch {
    return { ...EMPTY_PROFILE };
  }
}

export function updatePersonalizationProfile(
  butlerData: string,
  input: PersonalizationProfileUpdate,
): PersonalizationProfile {
  const next = {
    ...readPersonalizationProfile(butlerData),
    ...normalizeProfileUpdate(input),
    updated_at: new Date().toISOString(),
  };
  atomicWriteJson(personalizationProfilePath(butlerData), next);
  return next;
}

export function renderPersonalizationProfilePrompt(
  profile: PersonalizationProfile,
): string | null {
  const rows: string[] = [];
  if (profile.butler_nickname) {
    rows.push(`- Butler nickname: ${profile.butler_nickname}`);
  }
  if (profile.principal_name) {
    rows.push(`- Principal name: ${profile.principal_name}`);
  }
  if (profile.preferred_address) {
    rows.push(`- Address the principal as: ${profile.preferred_address}`);
  }
  if (rows.length === 0) return null;
  return [
    "# Personalization Profile",
    "",
    ...rows,
    "",
    "Use these naming preferences naturally. Do not force the address into every message.",
  ].join("\n");
}

function normalizeProfile(input: Partial<PersonalizationProfile>): PersonalizationProfile {
  return {
    butler_nickname: boundedProfileText(input.butler_nickname),
    principal_name: boundedProfileText(input.principal_name),
    preferred_address: boundedProfileText(input.preferred_address),
    updated_at: typeof input.updated_at === "string" ? input.updated_at : null,
  };
}

function normalizeProfileUpdate(
  input: PersonalizationProfileUpdate,
): PersonalizationProfileUpdate {
  const output: PersonalizationProfileUpdate = {};
  if ("butler_nickname" in input) {
    output.butler_nickname = boundedProfileText(input.butler_nickname);
  }
  if ("principal_name" in input) {
    output.principal_name = boundedProfileText(input.principal_name);
  }
  if ("preferred_address" in input) {
    output.preferred_address = boundedProfileText(input.preferred_address);
  }
  return output;
}

function boundedProfileText(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value.replace(/\r\n/gu, "\n").trim();
  return normalized.length > PROFILE_TEXT_LIMIT
    ? normalized.slice(0, PROFILE_TEXT_LIMIT)
    : normalized;
}

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(tmp, path);
}
