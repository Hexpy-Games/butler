import {
  apiEnvelope,
  isPersonalizationProfileMigrationRequest,
  isUpdatePersonalizationRequest,
  type PersonalizationProfileMigrationPromptView,
  type PersonalizationProfileMigrationResultView,
  type PersonalizationView,
} from "../../protocol/app-protocol.ts";
import { profileThirdPartyMigrationPrompt } from "../../../../../personalization/profiling.ts";
import { json, parseJson, RequestError } from "../responses.ts";

import type { AppRouteContext } from "../server-types.ts";

export async function handlePersonalizationRoutes(
  input: AppRouteContext,
): Promise<Response | null> {
  const { url } = input;
  if (input.request.method === "GET" && url.pathname === "/personalization") {
    return json(
      apiEnvelope<PersonalizationView>(input.store.getPersonalization()),
    );
  }
  if (
    input.request.method === "GET" &&
    url.pathname === "/personalization/profile-import-prompt"
  ) {
    const locale = url.searchParams.get("locale") === "ko" ? "ko" : "en";
    return json(
      apiEnvelope<PersonalizationProfileMigrationPromptView>({
        locale,
        prompt: profileThirdPartyMigrationPrompt(locale),
        raw_profile_included: false,
      }),
    );
  }
  if (input.request.method === "PATCH" && url.pathname === "/personalization") {
    const body = await parseJson(input.request);
    if (!isUpdatePersonalizationRequest(body)) {
      throw new RequestError(
        400,
        "invalid_personalization_request",
        "Personalization update contains unsupported fields.",
      );
    }
    return json(
      apiEnvelope<PersonalizationView>(input.store.updatePersonalization(body)),
    );
  }
  if (
    input.request.method === "POST" &&
    url.pathname === "/personalization/profile-import"
  ) {
    const body = await parseJson(input.request);
    if (!isPersonalizationProfileMigrationRequest(body)) {
      throw new RequestError(
        400,
        "invalid_personalization_profile_import",
        "Profile import requires text and optional source/model.",
      );
    }
    return json(
      apiEnvelope<PersonalizationProfileMigrationResultView>(
        await input.store.importPersonalizationProfile(body),
      ),
    );
  }
  return null;
}
