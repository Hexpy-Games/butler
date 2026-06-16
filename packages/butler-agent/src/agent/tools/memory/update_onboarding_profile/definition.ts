import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../../types.ts";

export const updateOnboardingProfileToolDefinition = {
  type: "function",
  name: "update_onboarding_profile",
  description: "Persist explicit answers from Butler's first-chat onboarding, including naming preferences, interests, work/main field, Butler nickname, desired treatment style, selected persona, and profile-learning consent. Use only for confirmed onboarding answers.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      principal_name: {
        type: "string",
        description: "The principal's name, if explicitly provided.",
      },
      preferred_address: {
        type: "string",
        description: "How Butler should address the principal.",
      },
      butler_nickname: {
        type: "string",
        description: "The name the principal wants Butler to use.",
      },
      interests: {
        type: "string",
        description: "Explicitly shared likes or interests.",
      },
      work: {
        type: "string",
        description: "Explicitly shared job, profession, or main field.",
      },
      service_preference: {
        type: "string",
        description: "How the principal wants Butler to behave or treat them.",
      },
      persona_preset: {
        type: "string",
        description: "Selected persona_preset id from the first-chat onboarding context, such as operator; use custom only when the user wrote their own persona.",
      },
      persona_custom: {
        type: "string",
        description: "Custom persona/treatment text when persona_preset is custom.",
      },
      profiling_mode: {
        type: "string",
        enum: [
          "off",
          "basic",
          "deep",
        ],
        description: "Consent-gated profile learning mode from first-chat onboarding. Set off when the principal declines or does not explicitly accept profile learning; set basic/deep only after explicit acceptance.",
      },
      skipped_fields: {
        type: "array",
        items: {
          type: "string",
        },
        description: "Onboarding field ids the principal chose to skip.",
      },
      complete: {
        type: "boolean",
        description: "Set true only when onboarding is finished or the principal asks to stop onboarding.",
      },
      locale: {
        type: "string",
        enum: [
          "en",
          "ko",
        ],
        description: "Language of the onboarding interaction.",
      },
    },
    required: [],
  },
  concurrencySafe: false,
  interruptBehavior: "continue",
  transcriptVisibility: "visible",
} satisfies ButlerToolDefinition;

export const updateOnboardingProfileToolMetadata = {
  category: "memory",
  tags: [
    "onboarding",
    "profile",
    "persona",
    "rapport",
    "개인화",
    "온보딩",
    "페르소나",
  ],
  safetyNotes: [
    "Persist only explicit first-chat onboarding answers; return raw-text-free status summaries.",
  ],
} satisfies ToolCapabilityMetadata;
