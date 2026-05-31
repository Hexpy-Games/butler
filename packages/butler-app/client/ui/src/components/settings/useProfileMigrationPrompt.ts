import { useEffect, useState } from "react";
import { api } from "@/app/api.ts";
import type { PersonalizationProfileMigrationPromptView } from "@/app/types.ts";

export function useProfileMigrationPrompt(
  expanded: boolean,
  language: string,
): string {
  const [prompt, setPrompt] = useState("");

  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    const query = new URLSearchParams({
      locale: language === "ko" ? "ko" : "en",
    });
    void api<PersonalizationProfileMigrationPromptView>(
      `/personalization/profile-import-prompt?${query.toString()}`,
    )
      .then((result) => {
        if (!cancelled) setPrompt(result.prompt);
      })
      .catch(() => {
        if (!cancelled) setPrompt("");
      });
    return () => {
      cancelled = true;
    };
  }, [expanded, language]);

  return prompt;
}
