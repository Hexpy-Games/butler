import type {
  SettingsView,
  WorkerProfile,
} from "../../../gateways/app/interface/protocol/settings-contract.ts";
import type { LocalAuthConfig } from
  "../../../gateways/app/interface/server/local-auth.ts";

export function createWorkerProfileReader(input: {
  appServerUrl: string;
  localAuth?: LocalAuthConfig;
  fetcher?: typeof fetch;
}): { read(profileId?: string): Promise<WorkerProfile> } {
  const baseUrl = input.appServerUrl.replace(/\/+$/u, "");
  const fetcher = input.fetcher ?? fetch;
  return {
    async read(profileId) {
      const headers: Record<string, string> = {};
      if (input.localAuth?.required) {
        if (!input.localAuth.token) throw new Error("app_local_auth_unconfigured");
        headers.authorization = `Bearer ${input.localAuth.token}`;
      }
      const response = await fetcher(`${baseUrl}/settings`, { headers });
      if (!response.ok) throw new Error(`worker_profile_settings_${response.status}`);
      const body = await response.json() as { data?: SettingsView };
      const profiles = body.data?.worker_profiles ?? [];
      const selected = profileId
        ? profiles.find((profile) => profile.id === profileId)
        : profiles.find((profile) => profile.id === "default");
      if (!selected?.enabled) throw new Error("worker_profile_unavailable");
      return selected;
    },
  };
}
