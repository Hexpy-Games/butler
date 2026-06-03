import { afterEach, expect, test } from "bun:test";
import {
  EMPTY_MODEL_CATALOG,
  EMPTY_NAVIGATION,
  EMPTY_SETTINGS,
} from "../../packages/butler-app/client/ui/src/app/constants.ts";
import { appCopy } from "../../packages/butler-app/client/ui/src/app/copy.ts";
import { writeCachedMessageList } from "../../packages/butler-app/client/ui/src/app/messageCache.ts";
import { useButlerStore } from "../../packages/butler-app/client/ui/src/app/store.ts";
import {
  activeTurnProgressSnapshot,
  applyTimelineEvents,
  freezeMessageWorkBlocks,
} from "../../packages/butler-app/client/ui/src/app/utils.ts";
import {
  editablePersonaText,
  personalizationDraftHasChanges,
  useSettingsUIStore,
} from "../../packages/butler-app/client/ui/src/stores/settingsUIStore.ts";
import type {
  MessageListView,
  MessageRecord,
  PersonalizationView,
  SettingsView,
  SessionSummaryView,
  SessionView,
  TurnProgressSnapshot,
} from "../../packages/butler-app/client/ui/src/app/types.ts";

const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
const originalCrypto = globalThis.crypto;

afterEach(() => {
  globalThis.fetch = originalFetch;
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: originalCrypto,
    writable: true,
  });
  useButlerStore.setState({
    activeChatId: "draft:chat",
    navigation: EMPTY_NAVIGATION,
    messages: [],
    messageLoadPending: false,
    sessionMessageViews: {},
    summary: null,
    sessionView: null,
    turnProgress: {},
    sessionQueue: [],
    settings: EMPTY_SETTINGS,
    modelCatalog: EMPTY_MODEL_CATALOG,
    status: { label: "connecting", tone: "muted" },
    isSending: false,
    sendingChatId: null,
    sendingOperations: {},
    leftOpen: false,
    rightOpen: true,
    rightTab: "summary",
    leftPanelWidth: 304,
    rightPanelWidth: 376,
    sidebarChatsCollapsed: false,
    sidebarProjectsCollapsed: false,
    sidebarCollapsedProjectIds: [],
  });
  useSettingsUIStore.setState({
    draft: null,
    personalization: null,
    personalizationDraft: {
      persona: "",
      eol: "",
      responseLanguage: "en",
      personaPreset: "custom",
      profile: {
        butler_nickname: "",
        principal_name: "",
        preferred_address: "",
      },
      profiling: {
        mode: "off",
        extractorModel: "default",
        extractorReasoningEffort: "medium",
        clearProfile: false,
      },
    },
    activeSection: "general",
    saving: false,
    localMessage: null,
  });
  if (originalWindow === undefined) {
    Reflect.deleteProperty(globalThis, "window");
  } else {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
      writable: true,
    });
  }
});

test("sendMessage works when browser randomUUID is unavailable", async () => {
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: {
      getRandomValues(bytes: Uint8Array) {
        bytes.fill(0);
        bytes[15] = 2;
        return bytes;
      },
    },
    writable: true,
  });
  let sendMessageBody: Record<string, unknown> | null = null;
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const path = String(input);
    if (path === "/messages" && init?.method === "POST") {
      sendMessageBody = JSON.parse(String(init.body ?? "{}")) as Record<
        string,
        unknown
      >;
      const messageId = String(sendMessageBody.client_message_id);
      return jsonResponse({
        accepted: messageRecord(
          messageId,
          "session-browser",
          "user",
          "hello",
          1,
          "turn-browser",
        ),
        replies: [],
      });
    }
    if (path === "/navigation") return jsonResponse(EMPTY_NAVIGATION);
    if (path.startsWith("/session-view")) {
      return jsonResponse(
        sessionView("session-browser", {
          messages: [],
          turnState: "thinking",
          latestProgress: {
            turn_id: "turn-browser",
            state: "thinking",
            safe_progress_rows: [],
          },
        }),
      );
    }
    return jsonResponse({});
  }) as unknown as typeof fetch;

  useButlerStore.setState({
    activeChatId: "session-browser",
    view: { kind: "session" },
    messages: [],
    summary: null,
  });

  await useButlerStore.getState().sendMessage("hello");

  expect(sendMessageBody).toMatchObject({
    chat_id: "session-browser",
    client_message_id: "client-00000000-0000-4000-8000-000000000002",
    text: "hello",
  });
});

test("fresh app state starts with the left sidebar collapsed", () => {
  expect(useButlerStore.getInitialState().leftOpen).toBe(false);
});

test("persona preset selection updates only the personalization draft until apply", async () => {
  const personalization: PersonalizationView = {
    persona: "current persona",
    eol: "current eol",
    updated_at: "2026-05-16T00:00:00.000Z",
    response_language: "en",
    profile: {
      butler_nickname: "Butler",
      principal_name: "Principal",
      preferred_address: "Principal",
      updated_at: null,
      storage_label: "personalization/profile.json",
    },
    profiling: {
      mode: "off",
      enabled: false,
      consent_version: "2026-05-16",
      consented_at: null,
      storage_label: "cognition/profile/profile.sqlite",
      raw_profile_browser_visible: false,
      extractor_model: "default",
      effective_extractor_model: "openai/gpt-5.5",
      extractor_uses_butler_model: true,
    },
    persona_presets: [
      {
        name: "guardian",
        label: "Guardian",
        description: "Steady guardian voice.",
        preview: "I will keep watch.",
        locale: "en",
        content:
          "---\nname: active\nbase: guardian\nbase_locale: en\n---\n\n# Guardian\n",
      },
    ],
  };
  const fetchCalls: Array<{ path: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push({ path: String(input), init });
    const body = JSON.parse(
      String(init?.body ?? "{}"),
    ) as Partial<PersonalizationView>;
    return jsonResponse<PersonalizationView>({
      ...personalization,
      ...body,
      eol: body.eol ?? personalization.eol,
      profile: body.profile ?? personalization.profile,
    });
  }) as unknown as typeof fetch;
  useSettingsUIStore.setState({
    personalization,
    personalizationDraft: {
      persona: personalization.persona,
      eol: personalization.eol,
      responseLanguage: "en",
      personaPreset: "custom",
      profile: {
        butler_nickname: "Butler",
        principal_name: "Principal",
        preferred_address: "Principal",
      },
      profiling: {
        mode: "off",
        extractorModel: "default",
        extractorReasoningEffort: "medium",
        clearProfile: false,
      },
    },
  });

  useSettingsUIStore.getState().selectPersonaPreset("guardian");

  expect(fetchCalls).toEqual([]);
  expect(useSettingsUIStore.getState().personalizationDraft).toMatchObject({
    persona: editablePersonaText(personalization.persona_presets[0].content),
    eol: "current eol",
    personaPreset: "guardian",
    profile: {
      butler_nickname: "Butler",
      principal_name: "Principal",
      preferred_address: "Principal",
    },
  });

  await useSettingsUIStore.getState().savePersonalization();

  expect(fetchCalls).toHaveLength(1);
  expect(fetchCalls[0].path).toBe("/personalization");
  expect(fetchCalls[0].init?.method).toBe("PATCH");
  expect(JSON.parse(String(fetchCalls[0].init?.body))).toEqual({
    persona: personalization.persona_presets[0].content,
  });
});

test("custom persona edits do not require visible frontmatter metadata", async () => {
  const personalization: PersonalizationView = {
    persona:
      "---\nname: active\nbase: neko-servant\nbase_locale: ko\n---\n\n# Neko\n",
    eol: "current eol",
    updated_at: "2026-05-16T00:00:00.000Z",
    response_language: "ko",
    profile: {
      butler_nickname: "Butler",
      principal_name: "Principal",
      preferred_address: "Principal",
      updated_at: null,
      storage_label: "personalization/profile.json",
    },
    profiling: {
      mode: "off",
      enabled: false,
      consent_version: "2026-05-16",
      consented_at: null,
      storage_label: "cognition/profile/profile.sqlite",
      raw_profile_browser_visible: false,
      extractor_model: "default",
      effective_extractor_model: "openai/gpt-5.5",
      extractor_uses_butler_model: true,
    },
    persona_presets: [
      {
        name: "neko-servant",
        label: "Neko Servant",
        description: "Playful attendant voice.",
        preview: "찾았다냐.",
        locale: "ko",
        content:
          "---\nname: active\nbase: neko-servant\nbase_locale: ko\n---\n\n# Neko\n",
      },
    ],
  };
  const fetchCalls: Array<{ path: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push({ path: String(input), init });
    if (!init) return jsonResponse<PersonalizationView>(personalization);
    const body = JSON.parse(
      String(init.body ?? "{}"),
    ) as Partial<PersonalizationView>;
    return jsonResponse<PersonalizationView>({
      ...personalization,
      ...body,
      eol: body.eol ?? personalization.eol,
      profile: body.profile ?? personalization.profile,
    });
  }) as unknown as typeof fetch;

  await useSettingsUIStore.getState().initialize(EMPTY_SETTINGS);

  expect(useSettingsUIStore.getState().personalizationDraft).toMatchObject({
    persona: "# Neko\n",
    personaPreset: "neko-servant",
  });
  expect(
    useSettingsUIStore.getState().personalizationDraft.persona,
  ).not.toContain("base_locale:");

  useSettingsUIStore.getState().setPersonalizationDraft((current) => ({
    ...current,
    persona: "Custom voice",
    personaPreset: "custom",
  }));
  await useSettingsUIStore.getState().savePersonalization();

  expect(fetchCalls).toHaveLength(2);
  expect(JSON.parse(String(fetchCalls[1].init?.body))).toEqual({
    persona: "Custom voice",
  });
});

test("profiling controls are saved only through the personalization apply path", async () => {
  const personalization: PersonalizationView = {
    persona: "current persona",
    eol: "current eol",
    updated_at: "2026-05-16T00:00:00.000Z",
    response_language: "en",
    profile: {
      butler_nickname: "",
      principal_name: "",
      preferred_address: "",
      updated_at: null,
      storage_label: "personalization/profile.json",
    },
    profiling: {
      mode: "off",
      enabled: false,
      consent_version: "2026-05-16",
      consented_at: null,
      storage_label: "cognition/profile/profile.sqlite",
      raw_profile_browser_visible: false,
      extractor_model: "default",
      effective_extractor_model: "openai/gpt-5.5",
      extractor_uses_butler_model: true,
    },
    persona_presets: [],
  };
  const fetchCalls: Array<{ path: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push({ path: String(input), init });
    const body = JSON.parse(
      String(init?.body ?? "{}"),
    ) as Partial<PersonalizationView>;
    return jsonResponse<PersonalizationView>({
      ...personalization,
      ...body,
      profiling: body.profiling
        ? {
            ...personalization.profiling,
            mode: body.profiling.mode ?? personalization.profiling.mode,
            enabled:
              (body.profiling.mode ?? personalization.profiling.mode) !== "off",
          }
        : personalization.profiling,
    });
  }) as unknown as typeof fetch;
  useSettingsUIStore.setState({
    personalization,
    personalizationDraft: {
      persona: personalization.persona,
      eol: personalization.eol,
      responseLanguage: "en",
      personaPreset: "custom",
      profile: {
        butler_nickname: "",
        principal_name: "",
        preferred_address: "",
      },
      profiling: {
        mode: "deep",
        extractorModel: "default",
        extractorReasoningEffort: "medium",
        clearProfile: true,
      },
    },
  });

  expect(
    personalizationDraftHasChanges(
      personalization,
      useSettingsUIStore.getState().personalizationDraft,
    ),
  ).toBe(true);
  await useSettingsUIStore.getState().savePersonalization();

  expect(fetchCalls).toHaveLength(1);
  expect(JSON.parse(String(fetchCalls[0].init?.body))).toEqual({
    profiling: {
      mode: "deep",
      clear_profile: true,
    },
  });
  expect(useSettingsUIStore.getState().personalizationDraft.profiling).toEqual({
    mode: "deep",
    extractorModel: "default",
    extractorReasoningEffort: "medium",
    clearProfile: false,
  });
});

test("response language is saved through the personalization apply path", async () => {
  const personalization: PersonalizationView = {
    persona: "current persona",
    eol: "current eol",
    updated_at: "2026-05-16T00:00:00.000Z",
    response_language: "ko",
    profile: {
      butler_nickname: "",
      principal_name: "",
      preferred_address: "",
      updated_at: null,
      storage_label: "personalization/profile.json",
    },
    profiling: {
      mode: "off",
      enabled: false,
      consent_version: "2026-05-16",
      consented_at: null,
      storage_label: "cognition/profile/profile.sqlite",
      raw_profile_browser_visible: false,
      extractor_model: "default",
      effective_extractor_model: "openai/gpt-5.5",
      extractor_uses_butler_model: true,
    },
    persona_presets: [],
  };
  const fetchCalls: Array<{ path: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push({ path: String(input), init });
    const body = JSON.parse(
      String(init?.body ?? "{}"),
    ) as Partial<PersonalizationView>;
    return jsonResponse<PersonalizationView>({
      ...personalization,
      response_language: body.response_language ?? personalization.response_language,
    });
  }) as unknown as typeof fetch;
  useSettingsUIStore.setState({
    personalization,
    personalizationDraft: {
      persona: personalization.persona,
      eol: personalization.eol,
      responseLanguage: "en",
      personaPreset: "custom",
      profile: {
        butler_nickname: "",
        principal_name: "",
        preferred_address: "",
      },
      profiling: {
        mode: "off",
        extractorModel: "default",
        extractorReasoningEffort: "medium",
        clearProfile: false,
      },
    },
  });

  await useSettingsUIStore.getState().savePersonalization();

  expect(fetchCalls).toHaveLength(1);
  expect(JSON.parse(String(fetchCalls[0].init?.body))).toEqual({
    response_language: "en",
  });
  expect(useSettingsUIStore.getState().personalizationDraft.responseLanguage).toBe(
    "en",
  );
});

test("profile migration import reports immediate profile application result", async () => {
  const personalization: PersonalizationView = {
    persona: "current persona",
    eol: "current eol",
    updated_at: "2026-05-16T00:00:00.000Z",
    response_language: "en",
    profile: {
      butler_nickname: "",
      principal_name: "",
      preferred_address: "",
      updated_at: null,
      storage_label: "personalization/profile.json",
    },
    profiling: {
      mode: "deep",
      enabled: true,
      consent_version: "2026-05-16",
      consented_at: "2026-05-16T00:00:00.000Z",
      storage_label: "cognition/profile/profile.sqlite",
      raw_profile_browser_visible: false,
      extractor_model: "default",
      effective_extractor_model: "openai/gpt-5.5",
      extractor_uses_butler_model: true,
    },
    persona_presets: [],
  };
  const fetchCalls: Array<{ path: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push({ path: String(input), init });
    return jsonResponse({
      profiling_enabled: true,
      mode: "deep",
      source: "external-ai",
      import_id: "third_party_profile_import:external-ai:hash",
      imported_candidate_count: 2,
      promoted_count: 2,
      skipped_count: 0,
      stable_entry_count: 4,
      projection_written: true,
      raw_text_included: false,
      model_called: true,
      fallback_used: false,
      personalization,
    });
  }) as unknown as typeof fetch;
  useSettingsUIStore.setState({
    personalization,
    personalizationDraft: {
      persona: personalization.persona,
      eol: personalization.eol,
      responseLanguage: "en",
      personaPreset: "custom",
      profile: {
        butler_nickname: "",
        principal_name: "",
        preferred_address: "",
      },
      profiling: {
        mode: "deep",
        extractorModel: "default",
        extractorReasoningEffort: "medium",
        clearProfile: false,
      },
    },
  });

  const importResult = useSettingsUIStore
    .getState()
    .importProfileMigration("third-party export");
  expect(useSettingsUIStore.getState().saving).toBe(true);
  await importResult;

  expect(fetchCalls).toHaveLength(1);
  expect(fetchCalls[0].path).toContain("/personalization/profile-import");
  expect(JSON.parse(String(fetchCalls[0].init?.body))).toEqual({
    text: "third-party export",
  });
  expect(useSettingsUIStore.getState().saving).toBe(false);
  expect(useSettingsUIStore.getState().localMessage).toEqual({
    tone: "ok",
    label: appCopy.settings.descriptions.profileMigrationApplied(2),
  });
});

test("legacy personalization responses without presets keep settings usable", async () => {
  const legacyPersonalization = {
    persona: "legacy persona",
    eol: "legacy eol",
    updated_at: "2026-05-16T00:00:00.000Z",
  } as unknown as PersonalizationView;
  globalThis.fetch = (async () =>
    jsonResponse<PersonalizationView>(
      legacyPersonalization,
    )) as unknown as typeof fetch;

  await useSettingsUIStore.getState().initialize(EMPTY_SETTINGS);

  expect(() =>
    useSettingsUIStore.getState().selectPersonaPreset("guardian"),
  ).not.toThrow();

  expect(useSettingsUIStore.getState().personalizationDraft).toMatchObject({
    persona: "legacy persona",
    eol: "legacy eol",
    responseLanguage: "en",
    personaPreset: "custom",
    profile: {
      butler_nickname: "",
      principal_name: "",
      preferred_address: "",
    },
  });
});

test("settings drafts fill default web search settings for legacy responses", async () => {
  const legacySettings = { ...EMPTY_SETTINGS } as Partial<SettingsView>;
  delete legacySettings.web_search;
  delete legacySettings.main_screen_theme;
  delete legacySettings.main_screen_theme_preset;
  delete legacySettings.main_screen_theme_custom_colors;
  globalThis.fetch = (async () =>
    jsonResponse<PersonalizationView>({
      persona: "",
      eol: "",
      updated_at: "2026-05-22T00:00:00.000Z",
      response_language: "en",
      persona_presets: [],
      profile: {
        butler_nickname: "",
        principal_name: "",
        preferred_address: "",
        updated_at: null,
        storage_label: "personalization/profile.json",
      },
      profiling: {
        mode: "off",
        enabled: false,
        consent_version: "2026-05-16",
        consented_at: null,
        storage_label: "cognition/profile/profile.sqlite",
        raw_profile_browser_visible: false,
        extractor_model: "default",
        effective_extractor_model: "openai/gpt-5.5",
        extractor_uses_butler_model: true,
      },
    })) as unknown as typeof fetch;

  await useSettingsUIStore
    .getState()
    .initialize(legacySettings as SettingsView);

  expect(useSettingsUIStore.getState().draft?.web_search).toEqual(
    EMPTY_SETTINGS.web_search,
  );
  expect(useSettingsUIStore.getState().draft).toMatchObject({
    main_screen_theme: EMPTY_SETTINGS.main_screen_theme,
    main_screen_theme_preset: EMPTY_SETTINGS.main_screen_theme_preset,
    main_screen_theme_custom_colors:
      EMPTY_SETTINGS.main_screen_theme_custom_colors,
  });
});

test("refreshSessionSummary ignores late responses for inactive sessions", async () => {
  let releaseResponse: (() => void) | undefined;
  globalThis.fetch = (async () => {
    await new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    return jsonResponse(
      sessionView("session-a", {
        turnState: "delivered",
        latestProgress: {
          turn_id: "turn-a",
          state: "delivered",
          safe_progress_rows: [],
        },
      }),
    );
  }) as unknown as typeof fetch;

  useButlerStore.setState({ activeChatId: "session-a", summary: null });
  const pending = useButlerStore.getState().refreshSessionSummary("session-a");
  useButlerStore.setState({ activeChatId: "session-b" });
  releaseResponse?.();
  await pending;

  expect(useButlerStore.getState().summary).toBeNull();
});

test("refreshSessionSummary preserves visible progress on transient failures", async () => {
  globalThis.fetch = (async () => {
    throw new Error("temporary session view failure");
  }) as unknown as typeof fetch;

  const progress: TurnProgressSnapshot = {
    turn_id: "turn-a",
    state: "running",
    safe_progress_rows: [
      {
        id: "row-a",
        kind: "searched",
        state: "running",
        safe_label: "Web search: source",
        safe_tool_name: "Web search",
        safe_input_label: "source",
      },
    ],
  };
  useButlerStore.setState({
    activeChatId: "session-a",
    summary: {
      session_id: "session-a",
      turn_state: "running",
      latest_progress: progress,
    },
    turnProgress: { "turn-a": progress },
  });

  await useButlerStore.getState().refreshSessionSummary("session-a");

  expect(useButlerStore.getState().summary?.latest_progress).toBe(progress);
  expect(useButlerStore.getState().turnProgress["turn-a"]).toBe(progress);
});

test("refreshSessionSummary seeds turn progress snapshots by turn id", async () => {
  globalThis.fetch = (async () =>
    jsonResponse(
      sessionView("session-a", {
        turnState: "delivered",
        latestProgress: {
          turn_id: "turn-a",
          state: "delivered",
          safe_progress_rows: [
            {
              id: "row-a",
              kind: "searched",
              state: "delivered",
              safe_label: "Web search: source",
              safe_tool_name: "Web search",
              safe_input_label: "source",
            },
          ],
        },
      }),
    )) as unknown as typeof fetch;

  useButlerStore.setState({
    activeChatId: "session-a",
    summary: null,
    turnProgress: {},
  });
  await useButlerStore.getState().refreshSessionSummary("session-a");

  expect(
    useButlerStore.getState().turnProgress["turn-a"]?.safe_progress_rows,
  ).toContainEqual(
    expect.objectContaining({
      safe_input_label: "source",
    }),
  );
});

test("refreshSessionSummary attaches completed work blocks to already visible replies", async () => {
  globalThis.fetch = (async () =>
    jsonResponse(
      sessionView("session-a", {
        messages: [
          {
            ...messageRecord(
              "assistant-a",
              "session-a",
              "assistant",
              "done",
              2,
              "turn-a",
            ),
            work_blocks: [
              {
                id: "work-a",
                label: "파일을 확인합니다.",
                state: "delivered",
                rows: [
                  {
                    id: "row-a",
                    kind: "ran_command",
                    state: "delivered",
                    safe_label: "Bash: inspect",
                    safe_tool_name: "Bash",
                    safe_input_label: "inspect",
                    work_block_id: "work-a",
                    work_block_label: "파일을 확인합니다.",
                  },
                ],
              },
            ],
          },
        ],
        turnState: "delivered",
        latestProgress: {
          turn_id: "turn-a",
          state: "delivered",
          safe_progress_rows: [
            {
              id: "row-a",
              kind: "ran_command",
              state: "delivered",
              safe_label: "Bash: inspect",
              safe_tool_name: "Bash",
              safe_input_label: "inspect",
              work_block_id: "work-a",
              work_block_label: "파일을 확인합니다.",
            },
          ],
        },
      }),
    )) as unknown as typeof fetch;

  useButlerStore.setState({
    activeChatId: "session-a",
    messages: [
      messageRecord(
        "assistant-a",
        "session-a",
        "assistant",
        "done",
        2,
        "turn-a",
      ),
    ],
    summary: null,
    turnProgress: {},
  });

  await useButlerStore.getState().refreshSessionSummary("session-a");

  expect(useButlerStore.getState().messages[0]?.work_blocks?.[0]?.label).toBe(
    "파일을 확인합니다.",
  );
  expect(
    useButlerStore.getState().messages[0]?.work_blocks?.[0]?.rows[0]
      ?.safe_input_label,
  ).toBe("inspect");
});

test("reloadMessages ignores late responses for inactive sessions", async () => {
  let releaseResponse: (() => void) | undefined;
  const message: MessageRecord = {
    id: "message-a",
    chat_id: "session-a",
    role: "assistant",
    text: "done",
    status: "delivered",
    retryable: false,
    cursor: 1,
    created_at: "2026-05-05T00:00:00.000Z",
    updated_at: "2026-05-05T00:00:00.000Z",
  };
  globalThis.fetch = (async () => {
    await new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    return jsonResponse<{ messages: MessageRecord[] }>({ messages: [message] });
  }) as unknown as typeof fetch;

  useButlerStore.setState({ activeChatId: "session-a", messages: [] });
  const pending = useButlerStore.getState().reloadMessages("session-a");
  useButlerStore.setState({ activeChatId: "session-b" });
  releaseResponse?.();
  await pending;

  expect(useButlerStore.getState().messages).toEqual([]);
});

test("reloadMessages hydrates turn progress for every loaded assistant turn", async () => {
  const chatId = "session-hydrate-progress";
  const messages: MessageRecord[] = [
    messageRecord("user-a", chatId, "user", "first", 1, "turn-a"),
    {
      ...messageRecord(
        "assistant-a",
        chatId,
        "assistant",
        "done first",
        2,
        "turn-a",
      ),
      work_blocks: [
        {
          id: "work-a",
          label: "Bash: first",
          state: "delivered",
          rows: [
            {
              id: "row-a",
              kind: "ran_command",
              state: "delivered",
              safe_label: "Bash: first",
              safe_tool_name: "Bash",
              safe_input_label: "first",
            },
          ],
        },
      ],
    },
    messageRecord("user-b", chatId, "user", "second", 3, "turn-b"),
    {
      ...messageRecord(
        "assistant-b",
        chatId,
        "assistant",
        "done second",
        4,
        "turn-b",
      ),
      work_blocks: [
        {
          id: "work-b",
          label: "Bash: second",
          state: "delivered",
          rows: [
            {
              id: "row-b",
              kind: "ran_command",
              state: "delivered",
              safe_label: "Bash: second",
              safe_tool_name: "Bash",
              safe_input_label: "second",
            },
          ],
        },
      ],
    },
  ];
  globalThis.fetch = (async () =>
    jsonResponse(
      sessionView(chatId, {
        messages,
        turnState: "delivered",
        latestProgress: {
          turn_id: "turn-b",
          state: "delivered",
          safe_progress_rows: messages[3]?.work_blocks?.[0]?.rows ?? [],
        },
      }),
    )) as unknown as typeof fetch;

  useButlerStore.setState({
    activeChatId: chatId,
    messages: [],
    turnProgress: {},
  });
  await useButlerStore.getState().reloadMessages(chatId);

  expect(
    useButlerStore.getState().messages[1]?.work_blocks?.[0]?.rows,
  ).toContainEqual(expect.objectContaining({ safe_input_label: "first" }));
  expect(
    useButlerStore.getState().messages[3]?.work_blocks?.[0]?.rows,
  ).toContainEqual(expect.objectContaining({ safe_input_label: "second" }));
});

test("message list hydration does not remove already visible live messages", () => {
  const user = messageRecord("user-a", "session-a", "user", "ask", 1, "turn-a");
  const assistant = messageRecord(
    "assistant-a",
    "session-a",
    "assistant",
    "working",
    2,
    "turn-a",
  );

  useButlerStore.setState({
    activeChatId: "session-a",
    messages: [user, assistant],
    turnProgress: {},
  });

  useButlerStore.getState().setMessageListView({
    chat_id: "session-a",
    messages: [user],
    turn_progress: {},
    next_cursor: 1,
  });

  expect(
    useButlerStore.getState().messages.map((message) => message.id),
  ).toEqual(["user-a", "assistant-a"]);
});

test("session view hydration does not remove already visible live messages", () => {
  const user = messageRecord("user-a", "session-a", "user", "ask", 1, "turn-a");
  const assistant = messageRecord(
    "assistant-a",
    "session-a",
    "assistant",
    "working",
    2,
    "turn-a",
  );

  useButlerStore.setState({
    activeChatId: "session-a",
    messages: [user, assistant],
    turnProgress: {},
  });

  useButlerStore.getState().setSessionView(
    sessionView("session-a", {
      messages: [],
      turnState: "thinking",
      latestProgress: {
        turn_id: "turn-a",
        state: "thinking",
        safe_progress_rows: [],
      },
    }),
  );

  expect(
    useButlerStore.getState().messages.map((message) => message.id),
  ).toEqual(["user-a", "assistant-a"]);
});

test("session view hydration preserves live turn progress rows", () => {
  const liveProgress: TurnProgressSnapshot = {
    turn_id: "turn-a",
    state: "running",
    updated_at: "2026-05-05T00:00:02.000Z",
    safe_progress_rows: [
      {
        id: "row-live",
        kind: "ran_command",
        state: "running",
        safe_label: "Bash: inspect",
        safe_tool_name: "Bash",
        safe_input_label: "inspect",
        work_block_id: "work-live",
        work_block_label: "파일을 확인합니다.",
      },
    ],
  };

  useButlerStore.setState({
    activeChatId: "session-a",
    messages: [],
    summary: {
      session_id: "session-a",
      turn_state: "running",
      latest_progress: liveProgress,
    },
    turnProgress: { "turn-a": liveProgress },
  });

  useButlerStore.getState().setSessionView(
    sessionView("session-a", {
      messages: [],
      turnState: "running",
      latestProgress: {
        turn_id: "turn-a",
        state: "running",
        updated_at: "2026-05-05T00:00:01.000Z",
        safe_progress_rows: [],
      },
    }),
  );

  expect(
    useButlerStore.getState().turnProgress["turn-a"]?.safe_progress_rows,
  ).toContainEqual(expect.objectContaining({ id: "row-live" }));
});

test("session view hydration reuses frozen assistant message references", () => {
  const progress: TurnProgressSnapshot = {
    turn_id: "turn-a",
    state: "delivered",
    safe_progress_rows: [
      {
        id: "row-command",
        kind: "ran_command",
        state: "delivered",
        safe_label: "Bash: inspect",
        safe_tool_name: "Bash",
        safe_input_label: "inspect",
        work_block_id: "work-a",
        work_block_label: "상태를 확인하는 중",
      },
    ],
  };
  const assistant = messageRecord(
    "assistant-a",
    "session-a",
    "assistant",
    "done",
    2,
    "turn-a",
  );
  const [frozenAssistant] = freezeMessageWorkBlocks([assistant], {
    "turn-a": progress,
  });
  const incomingAssistant: MessageRecord = {
    ...assistant,
    work_blocks: [
      {
        id: "work-a",
        label: "상태를 확인하는 중",
        state: "running",
        rows: [
          {
            ...progress.safe_progress_rows[0]!,
            state: "running",
          },
        ],
      },
    ],
  };

  useButlerStore.setState({
    activeChatId: "session-a",
    messages: [frozenAssistant!],
    turnProgress: { "turn-a": progress },
  });

  useButlerStore.getState().setSessionView(
    sessionView("session-a", {
      messages: [incomingAssistant],
      latestProgress: progress,
      turnState: "delivered",
    }),
  );

  expect(useButlerStore.getState().messages[0]).toBe(frozenAssistant);
});

test("session view hydration preserves active worker activity from stale snapshots", () => {
  useButlerStore.setState({
    activeChatId: "session-a",
    summary: {
      session_id: "session-a",
      turn_state: "running",
      latest_progress: {
        turn_id: "turn-a",
        state: "running",
        safe_progress_rows: [],
      },
      worker_activity: [
        {
          worker_id: "worker-live",
          activity_kind: "worker",
          worker_label: "Worker 1",
          objective: "조사",
          phase: "executing",
          status_line: "Executing",
          terminal: false,
          updated_at: "2026-05-16T00:00:02.000Z",
          supported_controls: ["cancel"],
        },
      ],
    },
    turnProgress: {
      "turn-a": {
        turn_id: "turn-a",
        state: "running",
        safe_progress_rows: [],
      },
    },
  });

  useButlerStore.getState().setSessionView(
    sessionView("session-a", {
      messages: [],
      turnState: "running",
      latestProgress: {
        turn_id: "turn-a",
        state: "running",
        safe_progress_rows: [],
      },
      workers: [],
    }),
  );

  expect(useButlerStore.getState().summary?.worker_activity).toContainEqual(
    expect.objectContaining({ worker_id: "worker-live" }),
  );
});

test("message list hydration preserves existing turn progress when server delta is partial", () => {
  const turnProgress: Record<string, TurnProgressSnapshot> = {
    "turn-a": {
      turn_id: "turn-a",
      state: "delivered",
      safe_progress_rows: [
        {
          id: "row-a",
          kind: "ran_command",
          state: "delivered",
          safe_label: "Bash: existing",
          safe_tool_name: "Bash",
          safe_input_label: "existing",
          work_block_id: "work-a",
          work_block_label: "기존 작업을 유지합니다.",
        },
      ],
    },
  };
  const [assistant] = freezeMessageWorkBlocks(
    [
      messageRecord(
        "assistant-a",
        "session-a",
        "assistant",
        "done",
        2,
        "turn-a",
      ),
    ],
    turnProgress,
  );

  useButlerStore.setState({
    activeChatId: "session-a",
    messages: [assistant!],
    turnProgress,
  });

  useButlerStore.getState().setMessageListView({
    chat_id: "session-a",
    messages: [
      messageRecord(
        "assistant-a",
        "session-a",
        "assistant",
        "done",
        2,
        "turn-a",
      ),
    ],
    turn_progress: {},
    next_cursor: 2,
  });

  expect(useButlerStore.getState().turnProgress["turn-a"]).toBe(
    turnProgress["turn-a"],
  );
  expect(useButlerStore.getState().messages[0]?.work_blocks?.[0]?.label).toBe(
    "기존 작업을 유지합니다.",
  );
});

test("timeline event batches never publish a completed reply before matching work blocks", () => {
  const publishedStates: boolean[] = [];
  const unsubscribe = useButlerStore.subscribe((state, previous) => {
    if (state.messages === previous.messages) return;
    const assistant = state.messages.find(
      (message) => message.id === "assistant-a",
    );
    if (!assistant) return;
    publishedStates.push(Boolean(assistant.work_blocks?.length));
  });

  useButlerStore.setState({
    activeChatId: "session-a",
    messages: [],
    summary: null,
    turnProgress: {},
    isSending: true,
    sendingChatId: "session-a",
    sendingOperations: {
      "send-a": "session-a",
    },
  });

  applyTimelineEvents(
    [
      {
        id: 10,
        type: "agent.turn_event.progress",
        payload: {
          session_id: "session-a",
          turn_id: "turn-a",
          row: {
            id: "row-a",
            kind: "ran_command",
            state: "delivered",
            safe_label: "Bash: inspect",
            safe_tool_name: "Bash",
            safe_input_label: "inspect",
            work_block_id: "work-a",
            work_block_label: "파일을 확인합니다.",
          },
        },
      },
      {
        id: 11,
        type: "message.created",
        payload: {
          message: messageRecord(
            "assistant-a",
            "session-a",
            "assistant",
            "done",
            2,
            "turn-a",
          ),
        },
      },
    ],
    "session-a",
    useButlerStore.getState().setMessages,
    useButlerStore.getState().setSummary,
    useButlerStore.getState().setTurnProgress,
  );

  unsubscribe();

  expect(publishedStates).toEqual([true]);
  expect(useButlerStore.getState().messages[0]?.work_blocks?.[0]?.label).toBe(
    "파일을 확인합니다.",
  );
});

test("timeline store action applies progress and messages in one publication", () => {
  useButlerStore.setState({
    activeChatId: "session-a",
    messages: [],
    summary: null,
    turnProgress: {},
  });
  const publishedStates: Array<{
    messages: number;
    workBlocks: number;
    progressRows: number;
  }> = [];
  const unsubscribe = useButlerStore.subscribe((state, previous) => {
    if (
      state.messages === previous.messages &&
      state.turnProgress === previous.turnProgress
    ) {
      return;
    }
    publishedStates.push({
      messages: state.messages.length,
      workBlocks: state.messages[0]?.work_blocks?.length ?? 0,
      progressRows:
        state.turnProgress["turn-a"]?.safe_progress_rows.length ?? 0,
    });
  });

  useButlerStore.getState().applyTimelineEvents([
    {
      id: 10,
      type: "agent.turn_event.progress",
      payload: {
        session_id: "session-a",
        turn_id: "turn-a",
        row: {
          id: "row-a",
          kind: "ran_command",
          state: "delivered",
          safe_label: "Bash: inspect",
          safe_tool_name: "Bash",
          safe_input_label: "inspect",
          work_block_id: "work-a",
          work_block_label: "파일을 확인합니다.",
        },
      },
    },
    {
      id: 11,
      type: "message.created",
      payload: {
        message: messageRecord(
          "assistant-a",
          "session-a",
          "assistant",
          "done",
          2,
          "turn-a",
        ),
      },
    },
  ]);

  unsubscribe();

  expect(publishedStates).toEqual([
    { messages: 1, workBlocks: 1, progressRows: 1 },
  ]);
});

test("store prunes optimistic client progress after server accepts the turn", () => {
  const clientMessageId = "client-accepted";
  const clientTurnId = `client-turn-${clientMessageId}`;
  useButlerStore.setState({
    activeChatId: "session-a",
    messages: [],
    summary: null,
    turnProgress: {
      [clientTurnId]: {
        turn_id: clientTurnId,
        state: "thinking",
        safe_progress_rows: [
          {
            id: "optimistic",
            kind: "thinking",
            state: "thinking",
            safe_label: "Thinking",
          },
        ],
      },
    },
  });

  useButlerStore.getState().applyTimelineEvents([
    {
      id: 12,
      type: "message.created",
      payload: {
        message: messageRecord(
          clientMessageId,
          "session-a",
          "user",
          "hello",
          1,
          "turn-real",
        ),
      },
    },
  ]);

  expect(useButlerStore.getState().turnProgress[clientTurnId]).toBeUndefined();
});

test("setSessionView does not regress terminal turn state from a stale refresh", () => {
  const terminalProgress: TurnProgressSnapshot = {
    turn_id: "turn-a",
    state: "delivered",
    updated_at: "2026-05-05T00:00:05.000Z",
    safe_progress_rows: [
      {
        id: "terminal-row",
        kind: "turn",
        state: "delivered",
        safe_label: "Completed",
      },
    ],
  };
  useButlerStore.setState({
    activeChatId: "session-a",
    sessionView: sessionView("session-a", {
      latestProgress: terminalProgress,
      turnState: "delivered",
    }),
    summary: {
      session_id: "session-a",
      turn_state: "delivered",
      latest_progress: terminalProgress,
    },
    turnProgress: { "turn-a": terminalProgress },
  });

  useButlerStore.getState().setSessionView(
    sessionView("session-a", {
      latestProgress: {
        turn_id: "turn-a",
        state: "thinking",
        updated_at: "2026-05-05T00:00:03.000Z",
        safe_progress_rows: [
          {
            id: "stale-active",
            kind: "thinking",
            state: "thinking",
            safe_label: "Queued for Butler service",
          },
        ],
      },
      turnState: "thinking",
    }),
  );

  expect(useButlerStore.getState().summary?.turn_state).toBe("delivered");
  expect(useButlerStore.getState().summary?.latest_progress?.state).toBe(
    "delivered",
  );
  expect(useButlerStore.getState().turnProgress["turn-a"]?.state).toBe(
    "delivered",
  );
  expect(useButlerStore.getState().isSending).toBe(false);
  expect(useButlerStore.getState().sendingOperations).toEqual({});
});

test("delivered assistant event freezes running progress before terminal turn event arrives", () => {
  useButlerStore.setState({
    activeChatId: "session-a",
    messages: [],
    summary: null,
    turnProgress: {},
  });

  applyTimelineEvents(
    [
      {
        id: 10,
        type: "agent.turn_event.progress",
        payload: {
          session_id: "session-a",
          turn_id: "turn-a",
          row: {
            id: "row-search",
            kind: "searched",
            state: "running",
            safe_label: "Web search: source",
            safe_tool_name: "Web search",
            safe_input_label: "source",
            work_block_id: "work-search",
            work_block_label: "공식 근거를 확인합니다.",
          },
        },
      },
    ],
    "session-a",
    useButlerStore.getState().setMessages,
    useButlerStore.getState().setSummary,
    useButlerStore.getState().setTurnProgress,
  );

  applyTimelineEvents(
    [
      {
        id: 11,
        type: "message.created",
        payload: {
          message: messageRecord(
            "assistant-a",
            "session-a",
            "assistant",
            "done",
            2,
            "turn-a",
          ),
        },
      },
    ],
    "session-a",
    useButlerStore.getState().setMessages,
    useButlerStore.getState().setSummary,
    useButlerStore.getState().setTurnProgress,
  );

  expect(useButlerStore.getState().messages[0]?.work_blocks?.[0]?.label).toBe(
    "공식 근거를 확인합니다.",
  );
  expect(
    useButlerStore.getState().messages[0]?.work_blocks?.[0]?.rows[0]?.state,
  ).toBe("delivered");
  expect(useButlerStore.getState().turnProgress["turn-a"]?.state).toBe(
    "delivered",
  );
});

test("completed todo progress does not hide active todo rows before final reply", () => {
  useButlerStore.setState({
    activeChatId: "session-a",
    messages: [],
    summary: null,
    turnProgress: {},
  });

  useButlerStore.getState().applyTimelineEvents([
    {
      id: 10,
      type: "agent.turn_event.progress",
      payload: {
        session_id: "session-a",
        turn_id: "turn-a",
        row: {
          id: "todo-inspect-running",
          kind: "todo",
          state: "running",
          safe_label: "구현 경로 확인",
        },
      },
    },
  ]);

  useButlerStore.getState().applyTimelineEvents([
    {
      id: 11,
      type: "agent.turn_event.progress",
      payload: {
        session_id: "session-a",
        turn_id: "turn-a",
        row: {
          id: "todo-inspect-delivered",
          kind: "todo",
          state: "delivered",
          safe_label: "구현 경로 확인",
        },
      },
    },
  ]);

  const activeProgress = activeTurnProgressSnapshot(
    useButlerStore.getState().summary,
    useButlerStore.getState().turnProgress,
  );

  expect(activeProgress?.state).toBe("running");
  expect(activeProgress?.safe_progress_rows).toContainEqual(
    expect.objectContaining({
      kind: "todo",
      safe_label: "구현 경로 확인",
      state: "delivered",
    }),
  );

  useButlerStore.getState().applyTimelineEvents([
    {
      id: 12,
      type: "message.created",
      payload: {
        message: messageRecord(
          "assistant-a",
          "session-a",
          "assistant",
          "done",
          2,
          "turn-a",
        ),
      },
    },
  ]);

  expect(
    activeTurnProgressSnapshot(
      useButlerStore.getState().summary,
      useButlerStore.getState().turnProgress,
    ),
  ).toBeNull();
  expect(useButlerStore.getState().turnProgress["turn-a"]?.state).toBe(
    "delivered",
  );
});

test("openSession synchronously paints cached completed messages", async () => {
  await writeCachedMessageList("session-cached-open", {
    chat_id: "session-cached-open",
    messages: [
      messageRecord(
        "assistant-cached",
        "session-cached-open",
        "assistant",
        "cached answer",
        7,
        "turn-cached",
      ),
    ],
    turn_progress: {
      "turn-cached": {
        turn_id: "turn-cached",
        state: "delivered",
        safe_progress_rows: [
          {
            id: "row-cached",
            kind: "ran_command",
            state: "delivered",
            safe_label: "Bash: cached",
          },
        ],
      },
    },
    next_cursor: 7,
  });

  useButlerStore.setState({
    activeChatId: "previous-session",
    messages: [
      messageRecord("previous", "previous-session", "assistant", "old", 1),
    ],
    turnProgress: {},
  });
  useButlerStore.getState().openSession("session-cached-open");

  expect(useButlerStore.getState().activeChatId).toBe("session-cached-open");
  expect(
    useButlerStore.getState().messages.map((message) => message.id),
  ).toEqual(["assistant-cached"]);
  expect(useButlerStore.getState().turnProgress["turn-cached"]?.state).toBe(
    "delivered",
  );
});

test("openSession restores an already opened session from in-memory view", () => {
  const turnProgress: Record<string, TurnProgressSnapshot> = {
    "turn-a": {
      turn_id: "turn-a",
      state: "delivered",
      safe_progress_rows: [
        {
          id: "row-a",
          kind: "ran_command",
          state: "delivered",
          safe_label: "Bash: cached in memory",
        },
      ],
    },
  };
  const [message] = freezeMessageWorkBlocks(
    [
      messageRecord(
        "assistant-a",
        "session-a",
        "assistant",
        "already opened",
        7,
        "turn-a",
      ),
    ],
    turnProgress,
  );
  useButlerStore.setState({
    activeChatId: "session-a",
    messages: [message!],
    turnProgress,
    sessionMessageViews: {},
    messageLoadPending: false,
  });

  useButlerStore.getState().openSession("session-b");
  expect(useButlerStore.getState().messageLoadPending).toBe(true);
  expect(useButlerStore.getState().messages).toEqual([]);

  useButlerStore.getState().openSession("session-a");
  expect(useButlerStore.getState().messageLoadPending).toBe(false);
  expect(useButlerStore.getState().messages[0]).toBe(message);
  expect(
    useButlerStore.getState().turnProgress["turn-a"]?.safe_progress_rows[0]
      ?.safe_label,
  ).toBe("Bash: cached in memory");
});

test("openSession restores a server-loaded session before debounce cache writes", () => {
  useButlerStore.setState({
    activeChatId: "session-a",
    messages: [],
    turnProgress: {},
    sessionMessageViews: {},
    messageLoadPending: true,
  });
  useButlerStore.getState().setMessageListView({
    chat_id: "session-a",
    messages: [
      messageRecord(
        "assistant-a",
        "session-a",
        "assistant",
        "loaded from server",
        4,
        "turn-a",
      ),
    ],
    turn_progress: {
      "turn-a": {
        turn_id: "turn-a",
        state: "delivered",
        safe_progress_rows: [
          {
            id: "row-a",
            kind: "ran_command",
            state: "delivered",
            safe_label: "Bash: server-loaded",
            safe_tool_name: "Bash",
            safe_input_label: "server-loaded",
          },
        ],
      },
    },
    next_cursor: 4,
  });

  useButlerStore.getState().openSession("session-b");
  useButlerStore.getState().openSession("session-a");

  expect(useButlerStore.getState().messageLoadPending).toBe(false);
  expect(
    useButlerStore.getState().messages.map((message) => message.id),
  ).toEqual(["assistant-a"]);
  expect(
    useButlerStore.getState().messages[0]?.work_blocks?.[0]?.rows,
  ).toHaveLength(1);
});

test("openSession paints cached messages even when cached work history is incomplete", async () => {
  await writeCachedMessageList("session-incomplete-open", {
    chat_id: "session-incomplete-open",
    messages: [
      messageRecord(
        "assistant-incomplete",
        "session-incomplete-open",
        "assistant",
        "cached answer",
        7,
        "turn-incomplete",
      ),
    ],
    turn_progress: {},
    next_cursor: 7,
  });

  useButlerStore.setState({
    activeChatId: "previous-session",
    messages: [
      messageRecord("previous", "previous-session", "assistant", "old", 1),
    ],
    turnProgress: {},
  });
  useButlerStore.getState().openSession("session-incomplete-open");

  expect(useButlerStore.getState().activeChatId).toBe(
    "session-incomplete-open",
  );
  expect(
    useButlerStore.getState().messages.map((message) => message.id),
  ).toEqual(["assistant-incomplete"]);
  expect(useButlerStore.getState().messages[0]?.work_blocks).toBeUndefined();
  expect(useButlerStore.getState().turnProgress).toEqual({});
  expect(useButlerStore.getState().messageLoadPending).toBe(false);
});

test("setMessages ignores structurally identical message rows", () => {
  const message = messageRecord(
    "message-a",
    "session-a",
    "assistant",
    "done",
    1,
  );
  useButlerStore.setState({ messages: [message] });
  let notifications = 0;
  const unsubscribe = useButlerStore.subscribe((state, previous) => {
    if (state.messages !== previous.messages) notifications += 1;
  });

  useButlerStore.getState().setMessages([{ ...message }]);

  unsubscribe();
  expect(notifications).toBe(0);
  expect(useButlerStore.getState().messages[0]).toBe(message);
});

test("reloadMessages paints cached messages first and syncs from cached cursor", async () => {
  const chatId = "session-reload-cursor";
  const writes: unknown[] = [];
  let snapshotRequests = 0;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: { origin: "http://butler.local" },
      butlerApp: {
        readCachedMessages: async () => ({
          schema: "butler.message-cache.v1",
          chat_id: chatId,
          cached_at: "2026-05-05T00:00:00.000Z",
          messages: [
            messageRecord("user-a", chatId, "user", "first", 1, "turn-a"),
            messageRecord(
              "assistant-a",
              chatId,
              "assistant",
              "done first",
              2,
              "turn-a",
            ),
          ],
          turn_progress: {
            "turn-a": {
              turn_id: "turn-a",
              state: "delivered",
              safe_progress_rows: [],
            },
          },
          next_cursor: 2,
        }),
        writeCachedMessages: async (input: unknown) => {
          writes.push(input);
          return { ok: true };
        },
        getSessionView: async ({ sessionId }: { sessionId: string }) => {
          snapshotRequests += 1;
          expect(sessionId).toBe(chatId);
          return sessionView(chatId, {
            messages: [
              messageRecord("user-a", chatId, "user", "first", 1, "turn-a"),
              messageRecord(
                "assistant-a",
                chatId,
                "assistant",
                "done first",
                2,
                "turn-a",
              ),
              messageRecord("user-b", chatId, "user", "second", 3, "turn-b"),
              messageRecord(
                "assistant-b",
                chatId,
                "assistant",
                "done second",
                4,
                "turn-b",
              ),
            ],
            turnState: "delivered",
            latestProgress: {
              turn_id: "turn-b",
              state: "delivered",
              safe_progress_rows: [],
            },
          });
        },
      },
    },
    writable: true,
  });

  useButlerStore.setState({
    activeChatId: chatId,
    messages: [],
    turnProgress: {},
  });
  await useButlerStore.getState().reloadMessages(chatId);

  expect(snapshotRequests).toBe(1);
  expect(
    useButlerStore.getState().messages.map((message) => message.id),
  ).toEqual(["user-a", "assistant-a", "user-b", "assistant-b"]);
  expect(Object.keys(useButlerStore.getState().turnProgress).sort()).toEqual([
    "turn-a",
    "turn-b",
  ]);
  expect(writes).toHaveLength(1);
});

test("reloadMessages paints cached messages before rehydrating missing work history", async () => {
  const chatId = "session-rehydrate-work-history";
  let snapshotRequests = 0;
  let releaseResponse: (() => void) | undefined;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: { origin: "http://butler.local" },
      butlerApp: {
        readCachedMessages: async () => ({
          schema: "butler.message-cache.v1",
          chat_id: chatId,
          cached_at: "2026-05-05T00:00:00.000Z",
          messages: [
            messageRecord("user-a", chatId, "user", "first", 1, "turn-a"),
            messageRecord(
              "assistant-a",
              chatId,
              "assistant",
              "done first",
              2,
              "turn-a",
            ),
            messageRecord("user-b", chatId, "user", "second", 3, "turn-b"),
            messageRecord(
              "assistant-b",
              chatId,
              "assistant",
              "done second",
              4,
              "turn-b",
            ),
          ],
          turn_progress: {},
          next_cursor: 4,
        }),
        writeCachedMessages: async () => ({ ok: true }),
        getSessionView: async () => {
          snapshotRequests += 1;
          await new Promise<void>((resolve) => {
            releaseResponse = resolve;
          });
          return sessionView(chatId, {
            messages: [
              messageRecord("user-a", chatId, "user", "first", 1, "turn-a"),
              {
                ...messageRecord(
                  "assistant-a",
                  chatId,
                  "assistant",
                  "done first",
                  2,
                  "turn-a",
                ),
                work_blocks: [
                  {
                    id: "work-a",
                    label: "Bash: first",
                    state: "delivered",
                    rows: [
                      {
                        id: "row-a",
                        kind: "ran_command",
                        state: "delivered",
                        safe_label: "Bash: first",
                        safe_tool_name: "Bash",
                        safe_input_label: "first",
                      },
                    ],
                  },
                ],
              },
              messageRecord("user-b", chatId, "user", "second", 3, "turn-b"),
              {
                ...messageRecord(
                  "assistant-b",
                  chatId,
                  "assistant",
                  "done second",
                  4,
                  "turn-b",
                ),
                work_blocks: [
                  {
                    id: "work-b",
                    label: "Bash: second",
                    state: "delivered",
                    rows: [
                      {
                        id: "row-b",
                        kind: "ran_command",
                        state: "delivered",
                        safe_label: "Bash: second",
                        safe_tool_name: "Bash",
                        safe_input_label: "second",
                      },
                    ],
                  },
                ],
              },
            ],
            turnState: "delivered",
            latestProgress: {
              turn_id: "turn-b",
              state: "delivered",
              safe_progress_rows: [
                {
                  id: "row-b",
                  kind: "ran_command",
                  state: "delivered",
                  safe_label: "Bash: second",
                  safe_tool_name: "Bash",
                  safe_input_label: "second",
                },
              ],
            },
          });
        },
      },
    },
    writable: true,
  });

  useButlerStore.setState({
    activeChatId: chatId,
    messages: [],
    turnProgress: {},
  });
  let messageNotifications = 0;
  const unsubscribe = useButlerStore.subscribe((state, previous) => {
    if (state.messages !== previous.messages) messageNotifications += 1;
  });
  const pending = useButlerStore.getState().reloadMessages(chatId);
  await waitFor(() => snapshotRequests === 1);

  expect(snapshotRequests).toBe(1);
  expect(messageNotifications).toBe(1);
  expect(
    useButlerStore.getState().messages.map((message) => message.id),
  ).toEqual(["user-a", "assistant-a", "user-b", "assistant-b"]);
  expect(useButlerStore.getState().messages[1]?.work_blocks).toBeUndefined();

  releaseResponse?.();
  await pending;
  unsubscribe();

  expect(messageNotifications).toBe(2);
  expect(
    useButlerStore.getState().messages[1]?.work_blocks?.[0]?.rows,
  ).toContainEqual(expect.objectContaining({ safe_input_label: "first" }));
});

test("setTurnProgress ignores structurally identical snapshots", () => {
  const snapshot: TurnProgressSnapshot = {
    turn_id: "turn-a",
    state: "delivered",
    safe_progress_rows: [
      {
        id: "row-a",
        kind: "ran_command",
        state: "delivered",
        safe_label: "Bash: bun test",
      },
    ],
  };
  useButlerStore.setState({ turnProgress: { "turn-a": snapshot } });
  let notifications = 0;
  const unsubscribe = useButlerStore.subscribe(() => {
    notifications += 1;
  });

  useButlerStore.getState().setTurnProgress({
    "turn-a": {
      ...snapshot,
      safe_progress_rows: [...snapshot.safe_progress_rows],
    },
  });
  unsubscribe();

  expect(notifications).toBe(0);
  expect(useButlerStore.getState().turnProgress["turn-a"]).toBe(snapshot);
});

test("completed message work blocks stay frozen across identical progress writes", () => {
  const snapshot: TurnProgressSnapshot = {
    turn_id: "turn-a",
    state: "delivered",
    safe_progress_rows: [
      {
        id: "row-a",
        kind: "ran_command",
        state: "delivered",
        safe_label: "Bash: cached",
        safe_tool_name: "Bash",
        safe_input_label: "cached",
      },
    ],
  };
  const [message] = freezeMessageWorkBlocks(
    [
      messageRecord(
        "assistant-a",
        "session-a",
        "assistant",
        "done",
        1,
        "turn-a",
      ),
    ],
    { "turn-a": snapshot },
  );
  useButlerStore.setState({
    messages: [message!],
    turnProgress: { "turn-a": snapshot },
  });
  let messageNotifications = 0;
  const unsubscribe = useButlerStore.subscribe((state, previous) => {
    if (state.messages !== previous.messages) messageNotifications += 1;
  });

  useButlerStore.getState().setTurnProgress({
    "turn-a": {
      ...snapshot,
      safe_progress_rows: [...snapshot.safe_progress_rows],
    },
  });
  unsubscribe();

  expect(messageNotifications).toBe(0);
  expect(useButlerStore.getState().messages[0]).toBe(message);
  expect(useButlerStore.getState().messages[0]?.work_blocks?.[0]?.rows[0]).toBe(
    snapshot.safe_progress_rows[0],
  );
});

test("active turn summary does not erase frozen work blocks from previous assistant messages", () => {
  const snapshot: TurnProgressSnapshot = {
    turn_id: "turn-a",
    state: "delivered",
    safe_progress_rows: [
      {
        id: "row-a",
        kind: "searched",
        state: "delivered",
        safe_label: "Web search: previous briefing",
        safe_tool_name: "Web search",
        safe_input_label: "previous briefing",
      },
    ],
  };
  const [message] = freezeMessageWorkBlocks(
    [
      messageRecord(
        "assistant-a",
        "session-a",
        "assistant",
        "done",
        1,
        "turn-a",
      ),
    ],
    { "turn-a": snapshot },
  );
  useButlerStore.setState({
    activeChatId: "session-a",
    messages: [message!],
    turnProgress: {},
    summary: {
      session_id: "session-a",
      turn_state: "delivered",
      latest_progress: {
        turn_id: "turn-a",
        state: "delivered",
        safe_progress_rows: [],
      },
    },
  });

  useButlerStore.getState().setSummary({
    session_id: "session-a",
    turn_state: "thinking",
    latest_progress: {
      turn_id: "turn-b",
      state: "thinking",
      safe_progress_rows: [
        {
          id: "thinking-turn-b",
          kind: "thinking",
          state: "thinking",
          safe_label: "Thinking",
        },
      ],
    },
  });

  expect(useButlerStore.getState().messages[0]).toBe(message);
  expect(useButlerStore.getState().messages[0]?.work_blocks?.[0]?.rows[0]).toBe(
    snapshot.safe_progress_rows[0],
  );
  expect(useButlerStore.getState().turnProgress["turn-b"]?.state).toBe(
    "thinking",
  );
});

test("hydrateUiState restores sidebar and panel presentation state", () => {
  useButlerStore.getState().hydrateUiState({
    schema: "butler.app-ui-state.v1",
    cached_at: "2026-05-13T10:00:00.000Z",
    left_open: false,
    right_open: false,
    right_tab: "context",
    left_panel_width: 356,
    right_panel_width: 440,
    sidebar_chats_collapsed: true,
    sidebar_projects_collapsed: true,
    sidebar_collapsed_project_ids: ["project-a", "project-b"],
  });

  expect(useButlerStore.getState()).toMatchObject({
    leftOpen: false,
    rightOpen: false,
    rightTab: "context",
    leftPanelWidth: 356,
    rightPanelWidth: 440,
    sidebarChatsCollapsed: true,
    sidebarProjectsCollapsed: true,
    sidebarCollapsedProjectIds: ["project-a", "project-b"],
  });
});

test("cancelActiveTurn sends worker cancel when only background worker is active", async () => {
  const calls: Array<{ path: string; body?: unknown }> = [];
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const path = String(input);
    calls.push({
      path,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (path.startsWith("/worker-activity/worker-running/control")) {
      return jsonResponse({
        worker: {
          worker_id: "worker-running",
          activity_kind: "worker",
          worker_label: "Worker 1",
          objective: "조사",
          phase: "cancelled",
          status_line: "Cancelled",
          terminal: true,
          updated_at: "2026-05-16T00:00:00.000Z",
          supported_controls: [],
        },
      });
    }
    if (path.startsWith("/messages")) {
      return jsonResponse<MessageListView>({
        chat_id: "session-a",
        messages: [],
        next_cursor: 0,
      });
    }
    if (path.startsWith("/session-summary")) {
      return jsonResponse<SessionSummaryView>({
        session_id: "session-a",
        turn_state: "delivered",
        latest_progress: {
          state: "delivered",
          safe_progress_rows: [],
        },
        worker_activity: [],
      });
    }
    return jsonResponse({});
  }) as unknown as typeof fetch;

  useButlerStore.setState({
    activeChatId: "session-a",
    summary: {
      session_id: "session-a",
      turn_state: "delivered",
      latest_progress: {
        state: "delivered",
        safe_progress_rows: [],
      },
      worker_activity: [
        {
          worker_id: "worker-running",
          activity_kind: "worker",
          worker_label: "Worker 1",
          objective: "조사",
          phase: "executing",
          status_line: "Executing",
          terminal: false,
          updated_at: "2026-05-16T00:00:00.000Z",
          supported_controls: ["cancel"],
        },
      ],
    },
  });

  await useButlerStore.getState().cancelActiveTurn();

  expect(calls).toContainEqual({
    path: "/worker-activity/worker-running/control",
    body: { action: "cancel" },
  });
  expect(calls.some((call) => call.path.startsWith("/turns/"))).toBe(false);
});

test("sendMessage keeps concurrent session sends scoped until each operation finishes", async () => {
  const releases = new Map<string, () => void>();
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const path = String(input);
    if (path === "/messages" && init?.method === "POST") {
      const body = JSON.parse(String(init.body ?? "{}")) as {
        chat_id: string;
        client_message_id: string;
        text: string;
      };
      await new Promise<void>((resolve) => {
        releases.set(body.chat_id, resolve);
      });
      return jsonResponse({
        accepted: messageRecord(
          body.client_message_id,
          body.chat_id,
          "user",
          body.text,
          1,
        ),
        replies: [
          messageRecord(
            `reply-${body.chat_id}`,
            body.chat_id,
            "assistant",
            "done",
            2,
          ),
        ],
      });
    }
    if (path === "/navigation") return jsonResponse(EMPTY_NAVIGATION);
    if (path.startsWith("/session-summary")) {
      const url = new URL(path, "http://butler.local");
      const sessionId = url.searchParams.get("session_id") ?? "session-a";
      return jsonResponse<SessionSummaryView>({
        session_id: sessionId,
        turn_state: "delivered",
        latest_progress: {
          state: "delivered",
          safe_progress_rows: [],
        },
      });
    }
    return jsonResponse({});
  }) as unknown as typeof fetch;

  useButlerStore.setState({
    activeChatId: "session-a",
    messages: [],
    summary: null,
  });
  const sendA = useButlerStore.getState().sendMessage("first");
  await waitFor(() => releases.has("session-a"));

  useButlerStore.setState({
    activeChatId: "session-b",
    messages: [],
    summary: null,
  });
  const sendB = useButlerStore.getState().sendMessage("second");
  await waitFor(() => releases.has("session-b"));

  useButlerStore.setState({
    activeChatId: "session-c",
    messages: [],
    summary: null,
  });
  const sendC = useButlerStore.getState().sendMessage("third");
  await waitFor(() => releases.has("session-c"));

  releases.get("session-b")?.();
  await sendB;
  expect(useButlerStore.getState().isSending).toBe(true);
  expect(Object.values(useButlerStore.getState().sendingOperations)).toEqual([
    "session-a",
    "session-c",
  ]);

  releases.get("session-a")?.();
  await sendA;
  expect(useButlerStore.getState().isSending).toBe(true);
  expect(Object.values(useButlerStore.getState().sendingOperations)).toEqual([
    "session-c",
  ]);

  releases.get("session-c")?.();
  await sendC;
  expect(useButlerStore.getState().isSending).toBe(false);
  expect(useButlerStore.getState().sendingOperations).toEqual({});
});

test("draft first send includes the initial message in session creation", async () => {
  const userText = "오늘을 비가 올것 같아?";
  let createSessionBody: Record<string, unknown> | null = null;
  let sendMessageBody: Record<string, unknown> | null = null;
  const acceptedUser = messageRecord(
    "client-weather",
    "session-weather",
    "user",
    userText,
    1,
    "turn-weather",
  );
  const assistantReply = messageRecord(
    "assistant-weather",
    "session-weather",
    "assistant",
    "오늘 날씨를 확인해볼게요.",
    2,
    "turn-weather",
  );

  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const path = String(input);
    if (path === "/sessions" && init?.method === "POST") {
      createSessionBody = JSON.parse(String(init.body ?? "{}")) as Record<
        string,
        unknown
      >;
      return jsonResponse({
        session: {
          id: "session-weather",
          kind: "chat",
          title: "오늘 날씨",
          last_activity_at: "2026-05-31T00:00:00.000Z",
          pinned: false,
          archived: false,
        },
      });
    }
    if (path === "/messages" && init?.method === "POST") {
      sendMessageBody = JSON.parse(String(init.body ?? "{}")) as Record<
        string,
        unknown
      >;
      return jsonResponse({
        accepted: acceptedUser,
        replies: [assistantReply],
      });
    }
    if (path === "/navigation") return jsonResponse(EMPTY_NAVIGATION);
    if (path.startsWith("/session-view")) {
      return jsonResponse(
        sessionView("session-weather", {
          messages: [acceptedUser, assistantReply],
          turnState: "delivered",
          latestProgress: {
            turn_id: "turn-weather",
            state: "delivered",
            safe_progress_rows: [],
          },
        }),
      );
    }
    if (path.startsWith("/session-queue")) {
      return jsonResponse({
        session_id: "session-weather",
        queued_messages: [],
      });
    }
    return jsonResponse({});
  }) as unknown as typeof fetch;

  useButlerStore.setState({
    activeChatId: "draft:chat",
    view: { kind: "session" },
    messages: [],
    summary: null,
  });

  await useButlerStore.getState().sendMessage(userText);

  expect(createSessionBody).toMatchObject({
    kind: "chat",
    title: userText,
    initial_message: userText,
  });
  expect(sendMessageBody).toMatchObject({
    chat_id: "session-weather",
    text: userText,
  });
  expect(useButlerStore.getState().activeChatId).toBe("session-weather");
});

test("sendMessage queues active-turn follow-ups without keeping an optimistic timeline row", async () => {
  const postedBodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const path = String(input);
    if (path === "/messages" && init?.method === "POST") {
      postedBodies.push(
        JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>,
      );
      return jsonResponse({
        queued: {
          id: "queued-follow-up",
          chat_id: "session-active",
          text: "queued follow-up",
          controls: {
            model: "openai/gpt-5.5",
            reasoning_effort: "medium",
            access_mode: "full_access",
            plan_mode: false,
          },
          state: "queued",
          cursor: 1,
          created_at: "2026-05-21T00:00:00.000Z",
          updated_at: "2026-05-21T00:00:00.000Z",
        },
        replies: [],
        next_cursor: 1,
      });
    }
    if (path.startsWith("/session-queue")) {
      return jsonResponse({
        session_id: "session-active",
        queued_messages: [
          {
            id: "queued-follow-up",
            chat_id: "session-active",
            text: "queued follow-up",
            controls: {
              model: "openai/gpt-5.5",
              reasoning_effort: "medium",
              access_mode: "full_access",
              plan_mode: false,
            },
            state: "queued",
            cursor: 1,
            created_at: "2026-05-21T00:00:00.000Z",
            updated_at: "2026-05-21T00:00:00.000Z",
          },
        ],
      });
    }
    return jsonResponse({});
  }) as unknown as typeof fetch;

  useButlerStore.setState({
    activeChatId: "session-active",
    view: { kind: "session" },
    messages: [
      messageRecord(
        "existing-user",
        "session-active",
        "user",
        "current task",
        1,
        "turn-active",
      ),
    ],
    summary: {
      session_id: "session-active",
      turn_state: "thinking",
      latest_progress: {
        turn_id: "turn-active",
        state: "thinking",
        safe_progress_rows: [],
      },
    },
  });

  await useButlerStore
    .getState()
    .sendMessage("queued follow-up", { queuePolicy: "enqueue_if_busy" });

  expect(postedBodies[0]?.queue_policy).toBe("enqueue_if_busy");
  expect(
    useButlerStore.getState().messages.map((message) => message.text),
  ).toEqual(["current task"]);
  expect(useButlerStore.getState().sessionQueue).toMatchObject([
    {
      id: "queued-follow-up",
      text: "queued follow-up",
      state: "queued",
    },
  ]);
  expect(useButlerStore.getState().isSending).toBe(false);
});

test("sendMessage clears optimistic pending state when an immediate reply arrives", async () => {
  let acceptedUser: MessageRecord | null = null;
  let assistantReply: MessageRecord | null = null;
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const path = String(input);
    if (path === "/messages" && init?.method === "POST") {
      const body = JSON.parse(String(init.body ?? "{}")) as {
        chat_id: string;
        client_message_id: string;
        text: string;
      };
      acceptedUser = messageRecord(
        body.client_message_id,
        body.chat_id,
        "user",
        body.text,
        10,
        "turn-current",
      );
      assistantReply = messageRecord(
        "assistant-current",
        body.chat_id,
        "assistant",
        "visible final",
        11,
        "turn-current",
      );
      return jsonResponse({
        accepted: acceptedUser,
        replies: [assistantReply],
      });
    }
    if (path === "/navigation") return jsonResponse(EMPTY_NAVIGATION);
    if (path.startsWith("/session-view")) {
      return jsonResponse(
        sessionView("session-immediate", {
          messages: [acceptedUser!, assistantReply!],
          turnState: "thinking",
          latestProgress: {
            turn_id: "turn-current",
            state: "thinking",
            updated_at: "2026-05-19T00:00:01.000Z",
            safe_progress_rows: [
              {
                id: "thinking-turn-current",
                kind: "thinking",
                state: "thinking",
                safe_label: "Thinking",
              },
            ],
          },
        }),
      );
    }
    return jsonResponse({});
  }) as unknown as typeof fetch;

  useButlerStore.setState({
    activeChatId: "session-immediate",
    view: { kind: "session" },
    messages: [],
    summary: {
      session_id: "session-immediate",
      turn_state: "idle",
      latest_progress: {
        state: "idle",
        safe_progress_rows: [],
      },
    },
  });

  await useButlerStore.getState().sendMessage("hello");
  const state = useButlerStore.getState();

  expect(state.isSending).toBe(false);
  expect(state.sendingOperations).toEqual({});
  expect(state.summary?.turn_state).toBe("delivered");
  expect(state.summary?.latest_progress?.turn_id).toBe("turn-current");
  expect(state.summary?.latest_progress?.state).toBe("delivered");
  expect(state.turnProgress["turn-current"]?.state).toBe("delivered");
  expect(
    Object.keys(state.turnProgress).some((turnId) =>
      turnId.startsWith("client-turn-"),
    ),
  ).toBe(false);
  expect(state.messages.map((message) => message.role)).toEqual([
    "user",
    "assistant",
  ]);
});

test("sendMessage keeps accepted messages visible when post-send session refresh is stale", async () => {
  let acceptedUser: MessageRecord | null = null;
  let assistantReply: MessageRecord | null = null;
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const path = String(input);
    if (path === "/messages" && init?.method === "POST") {
      const body = JSON.parse(String(init.body ?? "{}")) as {
        chat_id: string;
        client_message_id: string;
        text: string;
      };
      acceptedUser = messageRecord(
        body.client_message_id,
        body.chat_id,
        "user",
        body.text,
        10,
        "turn-current",
      );
      assistantReply = messageRecord(
        "assistant-current",
        body.chat_id,
        "assistant",
        "visible final",
        11,
        "turn-current",
      );
      return jsonResponse({
        accepted: acceptedUser,
        replies: [assistantReply],
      });
    }
    if (path === "/navigation") return jsonResponse(EMPTY_NAVIGATION);
    if (path.startsWith("/session-view")) {
      return jsonResponse(
        sessionView("session-stale-refresh", {
          messages: [],
          turnState: "thinking",
          latestProgress: {
            turn_id: "turn-current",
            state: "thinking",
            updated_at: "2026-05-19T00:00:01.000Z",
            safe_progress_rows: [],
          },
        }),
      );
    }
    return jsonResponse({});
  }) as unknown as typeof fetch;

  useButlerStore.setState({
    activeChatId: "session-stale-refresh",
    view: { kind: "session" },
    messages: [],
    summary: {
      session_id: "session-stale-refresh",
      turn_state: "idle",
      latest_progress: {
        state: "idle",
        safe_progress_rows: [],
      },
    },
  });

  await useButlerStore.getState().sendMessage("hello");

  expect(
    useButlerStore.getState().messages.map((message) => message.role),
  ).toEqual(["user", "assistant"]);
  expect(useButlerStore.getState().messages[0]?.text).toBe("hello");
  expect(useButlerStore.getState().messages.at(-1)?.text).toBe("visible final");
});

test("sendMessage reloads messages when app transport returns no immediate reply", async () => {
  const calls: string[] = [];
  let acceptedUser: MessageRecord | null = null;
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const path = String(input);
    calls.push(path);
    if (path === "/messages" && init?.method === "POST") {
      const body = JSON.parse(String(init.body ?? "{}")) as {
        chat_id: string;
        client_message_id: string;
        text: string;
      };
      acceptedUser = messageRecord(
        body.client_message_id,
        body.chat_id,
        "user",
        body.text,
        10,
        "turn-current",
      );
      return jsonResponse({
        accepted: acceptedUser,
        replies: [],
      });
    }
    if (path === "/navigation") return jsonResponse(EMPTY_NAVIGATION);
    if (path.startsWith("/session-view")) {
      return jsonResponse(
        sessionView("session-no-reply", {
          messages: [
            acceptedUser ??
              messageRecord(
                "fallback-user-current",
                "session-no-reply",
                "user",
                "hello",
                10,
                "turn-current",
              ),
            messageRecord(
              "assistant-current",
              "session-no-reply",
              "assistant",
              "visible final",
              11,
              "turn-current",
            ),
          ],
          turnState: "delivered",
          latestProgress: {
            turn_id: "turn-current",
            state: "delivered",
            updated_at: "2026-05-19T00:00:03.000Z",
            safe_progress_rows: [],
          },
        }),
      );
    }
    return jsonResponse({});
  }) as unknown as typeof fetch;

  useButlerStore.setState({
    activeChatId: "session-no-reply",
    view: { kind: "session" },
    messages: [],
    summary: null,
  });

  await useButlerStore.getState().sendMessage("hello");

  expect(calls.some((path) => path.startsWith("/session-view"))).toBe(true);
  expect(
    useButlerStore.getState().messages.map((message) => message.role),
  ).toEqual(["user", "assistant"]);
  expect(useButlerStore.getState().messages.at(-1)?.text).toBe("visible final");
});

function jsonResponse<T>(data: T): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function messageRecord(
  id: string,
  chatId: string,
  role: MessageRecord["role"],
  text: string,
  cursor: number,
  turnId?: string,
): MessageRecord {
  return {
    id,
    chat_id: chatId,
    turn_id: turnId,
    role,
    text,
    status: "delivered",
    retryable: false,
    cursor,
    created_at: "2026-05-05T00:00:00.000Z",
    updated_at: "2026-05-05T00:00:00.000Z",
  };
}

function sessionView(
  sessionId: string,
  input: {
    messages?: MessageRecord[];
    latestProgress?: TurnProgressSnapshot;
    turnState?: string;
    workers?: SessionView["workers"];
  } = {},
): SessionView {
  const turnId = input.latestProgress?.turn_id;
  const state = input.turnState ?? input.latestProgress?.state ?? "idle";
  return {
    protocol_version: "butler.app.v1",
    session_id: sessionId,
    kind: "chat",
    status:
      state === "idle"
        ? "idle"
        : state === "delivered"
          ? "delivered"
          : "active",
    active_turn:
      turnId &&
      state !== "delivered" &&
      state !== "failed" &&
      state !== "cancelled"
        ? {
            id: turnId,
            state,
            safe_status_label: "Working",
            cancellable: true,
            retryable: false,
            progress: input.latestProgress ?? {
              turn_id: turnId,
              state,
              safe_progress_rows: [],
            },
            created_at: "2026-05-05T00:00:00.000Z",
            updated_at: "2026-05-05T00:00:00.000Z",
          }
        : null,
    latest_turn: turnId
      ? {
          id: turnId,
          state,
          safe_status_label: "Working",
          cancellable: state !== "delivered",
          retryable: false,
          progress: input.latestProgress ?? {
            turn_id: turnId,
            state,
            safe_progress_rows: [],
          },
          created_at: "2026-05-05T00:00:00.000Z",
          updated_at: "2026-05-05T00:00:00.000Z",
        }
      : null,
    messages: input.messages ?? [],
    message_window: { next_cursor: 0, complete: true },
    workers: input.workers ?? [],
    work_streams: [],
    artifacts: [],
    context: null,
    branch: null,
    automations: [],
    errors: [],
    cursors: { messages: 0, events: 0 },
    generated_at: "2026-05-05T00:00:00.000Z",
    updated_at: "2026-05-05T00:00:00.000Z",
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for condition.");
}
