import type { AppCopy } from "./copy.ts";
import type {
  PersonalizationProfileMigrationResultView,
  StatusTone,
} from "./types.ts";

export interface ProfileMigrationFeedback {
  tone: StatusTone;
  label: string;
}

export function profileMigrationFeedbackFromResult(
  settingsCopy: AppCopy["settings"],
  result: PersonalizationProfileMigrationResultView,
): ProfileMigrationFeedback {
  if (!result.profiling_enabled) {
    return {
      tone: "muted",
      label: settingsCopy.errors.profileMigrationProfilingOff,
    };
  }
  if (result.promoted_count > 0) {
    return {
      tone: "ok",
      label: settingsCopy.descriptions.profileMigrationApplied(
        result.promoted_count,
      ),
    };
  }
  if (result.imported_candidate_count > 0) {
    return {
      tone: "muted",
      label: settingsCopy.descriptions.profileMigrationStored,
    };
  }
  return {
    tone: "muted",
    label: settingsCopy.descriptions.profileMigrationNoNewInfo,
  };
}
