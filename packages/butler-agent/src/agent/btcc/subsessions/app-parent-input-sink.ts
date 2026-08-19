import type { ParentInputSink } from "./contracts.ts";
import type { LocalAuthConfig } from "../../../gateways/app/interface/server/local-auth.ts";

/** Typed adapter to the canonical AppUserMessageTurnStore result ingress. */
export function createAppParentInputSink(input: {
  appServerUrl: string;
  localAuth?: LocalAuthConfig;
  fetcher?: typeof fetch;
}): ParentInputSink {
  const fetcher = input.fetcher ?? fetch;
  const baseUrl = input.appServerUrl.replace(/\/+$/u, "");
  return async (parentInput) => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (input.localAuth?.required) {
      if (!input.localAuth.token) throw new Error("app_local_auth_unconfigured");
      headers.authorization = `Bearer ${input.localAuth.token}`;
    }
    const response = await fetcher(`${baseUrl}/internal/subsession-result`, {
      method: "POST",
      headers,
      body: JSON.stringify(parentInput),
    });
    if (!response.ok) {
      throw new Error(`app_subsession_result_ingress_${response.status}`);
    }
  };
}
