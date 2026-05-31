type CountFormatter = (count: number) => string;
type AppLocale = "ko-KR";

interface ConversationWorkCopy {
  historyRegionLabel: string;
  pendingLabel: string;
  pendingStateLabels: Record<string, string>;
  todoListRegionLabel: string;
  todoListTitle: string;
  todoItemPendingLabel: string;
  todoItemRunningLabel: string;
  todoItemCompletedLabel: string;
  todoItemFailedLabel: string;
  todoItemCancelledLabel: string;
  collapsedSummary: (primaryLabel: string, count: number) => string;
  expandHistoryLabel: (primaryLabel: string, count: number) => string;
  collapseHistoryLabel: (primaryLabel: string, count: number) => string;
  toolchainRegionLabel: (label: string) => string;
  detailsRegionLabel: (label: string) => string;
  webSearchSummary: CountFormatter;
  toolStepsSummary: (toolName: string, count: number) => string;
  webSearchDetail: (value: string) => string;
  detailRow: (label: string, value: string) => string;
}

interface ConversationCopy {
  work: ConversationWorkCopy;
  result: {
    regionLabel: string;
  };
  failure: {
    regionLabel: string;
    title: string;
    retry: string;
    retrying: string;
    fallbackReason: string;
  };
}

export interface AppCopy {
  conversation: ConversationCopy;
  sessionActions: {
    menuLabel: string;
    rename: string;
    archive: string;
    renameTitle: string;
    renameField: string;
    cancel: string;
    save: string;
  };
  sidebar: {
    regionLabel: string;
    newChat: string;
    search: string;
    automations: string;
    projects: string;
    chats: string;
    settings: string;
    expandProjects: string;
    collapseProjects: string;
    expandChats: string;
    collapseChats: string;
    newProject: string;
    startFromScratch: string;
    useExistingFolder: string;
    availableInDesktop: string;
    projectDashboard: string;
    newProjectChat: string;
    projectMenu: string;
    projectRenameTitle: string;
    projectName: string;
    pin: string;
    unpin: string;
    delete: string;
    projectDeleteConfirm: (projectName: string) => string;
  };
  composer: {
    messageComposer: string;
    placeholder: string;
    placeholderFollowUp: string;
    attachedFiles: string;
    removeFile: (fileName: string) => string;
    attachFile: string;
    permission: string;
    plan: string;
    model: string;
    modelSearch: string;
    modelSearchClear: string;
    allProviders: string;
    noModels: string;
    reasoning: string;
    reasoningEffort: string;
    send: string;
    stop: string;
    queuedMessages: string;
    queuedMessage: string;
    queuedMessageStatus: string;
    queuedAttachmentCount: (count: number) => string;
    editQueuedMessage: string;
    deleteQueuedMessage: string;
    contextDetails: string;
  };
  permissions: {
    fullAccess: string;
    fullAccessDesc: string;
    askFirst: string;
    askFirstDesc: string;
    readOnly: string;
    readOnlyDesc: string;
  };
  automations: {
    title: string;
    scheduledCount: (count: number) => string;
    empty: string;
    new: string;
    detailFallback: string;
    backLabel: string;
    runNow: string;
    resume: string;
    pause: string;
    fields: {
      title: string;
      prompt: string;
      details: string;
      targetChat: string;
      interval: string;
      customMinutes: string;
      state: string;
      runs: string;
    };
    placeholders: {
      title: string;
      prompt: string;
    };
    runs: {
      empty: string;
      queued: string;
      succeeded: string;
      failed: string;
      running: string;
      skippedTargetUnavailable: string;
      cancelled: string;
      notRun: string;
    };
    inspector: {
      empty: string;
    };
  };
  artifacts: {
    title: string;
    empty: string;
    backToList: string;
    open: string;
    save: string;
    saved: string;
    saveFailed: string;
    loading: string;
    unsupported: string;
    loadFailed: string;
  };
  inspector: {
    tabs: {
      summary: string;
      context: string;
      artifacts: string;
      automations: string;
      workers: string;
    };
    workers: {
      showDetails: string;
      hideDetails: string;
    };
  };
  common: {
    close: string;
    more: string;
    refresh: string;
    save: string;
    cancel: string;
    delete: string;
    copy: string;
  };
  settings: {
    title: string;
    back: string;
    saving: string;
    saved: string;
    sectionsLabel: string;
    sections: {
      general: string;
      notifications: string;
      desktopShell: string;
      models: string;
      appearance: string;
      server: string;
      updates: string;
      mcp: string;
      skills: string;
      usage: string;
      personalization: string;
      privacy: string;
      system: string;
      archives: string;
      about: string;
    };
    panels: {
      butlerModel: string;
      workerModelRules: string;
      serverBridge: string;
      updates: string;
      mcpServers: string;
      skills: string;
      usageMonitor: string;
      privacyDiagnostics: string;
      systemEvents: string;
      archives: string;
      about: string;
    };
    fields: {
      language: string;
      timezone: string;
      followUpBehavior: string;
      multilineSend: string;
      searchSettings: string;
      searchProvider: string;
      searchProviderApiKey: string;
      searchReaderBackend: string;
      searchPlanningEnabled: string;
      searchDefaultDepth: string;
      butlerModel: string;
      butlerReasoning: string;
      consolidationModel: string;
      localReasoningBudget: string;
      contextLimit: string;
      access: string;
      planModeDefault: string;
      enabled: string;
      condition: string;
      model: string;
      reasoning: string;
      theme: string;
      mainScreenTheme: string;
      mainScreenThemePreset: string;
      mainScreenThemeColors: string;
      mainScreenThemeColor: (index: number) => string;
      themeSamples: string;
      translucentSidebar: string;
      desktopNotifications: string;
      desktopNotificationAssistantMessages: string;
      desktopNotificationTaskCompletions: string;
      desktopTray: string;
      bridgeMode: string;
      serverUrl: string;
      defaultProjectFolder: string;
      diagnostics: string;
      appName: string;
      appVersion: string;
      appRepository: string;
      appProtocol: string;
      developerMode: string;
      butlerNickname: string;
      principalName: string;
      preferredAddress: string;
      profilingMode: string;
      profilingExtractorModel: string;
      profileMigrationImport: string;
      profileMigrationPrompt: string;
      profileMigrationDump: string;
      personaPreset: string;
      persona: string;
      eol: string;
      mcpServerId: string;
      mcpServerName: string;
      mcpTransport: string;
      mcpCommand: string;
      mcpArgs: string;
      mcpUrl: string;
      mcpCwd: string;
      mcpEnv: string;
      mcpHeaders: string;
    };
    options: {
      english: string;
      korean: string;
      queueWhileBusy: string;
      steerCurrentTurn: string;
      modifierEnterSendEnterNewline: string;
      enterSendShiftEnterNewline: string;
      system: string;
      light: string;
      dark: string;
      mainScreenThemeNone: string;
      mainScreenThemeBloom: string;
      mainScreenThemeSilk: string;
      paletteMonochrome: string;
      paletteAurora: string;
      paletteBloom: string;
      paletteLavender: string;
      paletteMorning: string;
      paletteCustom: string;
      local: string;
      external: string;
      customPersona: string;
      profilingOff: string;
      profilingBasic: string;
      profilingDeep: string;
      profilingExtractorDefault: string;
      consolidationModelDefault: string;
      stdio: string;
      http: string;
      sse: string;
      searchProviderDuckDuckGo: string;
      searchProviderAuto: string;
      searchProviderBrave: string;
      searchProviderTavily: string;
      searchProviderOpenAi: string;
      searchProviderCodex: string;
      searchProviderDisabled: string;
      searchReaderLightweight: string;
      searchReaderAuto: string;
      searchReaderLightpanda: string;
      searchReaderJina: string;
      searchReaderDisabled: string;
      searchDepthQuick: string;
      searchDepthBalanced: string;
      searchDepthDeep: string;
      timezoneSearch: string;
      timezoneSearchClear: string;
      timezoneAll: string;
      timezoneEmpty: string;
    };
    descriptions: {
      runtimeSupportedModelsOnly: string;
      language: string;
      timezone: string;
      consolidationModel: string;
      consolidationModelDefault: string;
      localReasoningBudget: string;
      mainScreenTheme: string;
      mainScreenThemePreset: string;
      mainScreenThemeColors: string;
      contextLimit: (maxLabel: string) => string;
      contextLimitClamped: (value: string) => string;
      personaPreset: string;
      profilingMode: string;
      profilingOff: string;
      profilingBasic: string;
      profilingDeep: string;
      profilingExtractorModel: string;
      profilingExtractorDefault: string;
      profileMigration: string;
      profileMigrationImmediate: string;
      profileMigrationImporting: string;
      profileMigrationApplied: CountFormatter;
      profileMigrationStored: string;
      profileMigrationNoNewInfo: string;
      systemEvents: string;
      systemEventsEmpty: string;
      updates: string;
      eolLastLoaded: (value: string) => string;
      mcpServers: string;
      mcpSecrets: string;
      skills: string;
      usageMonitor: string;
      usageMonitorEmpty: string;
      searchSettings: string;
      searchProvider: string;
      searchProviderApiKey: (envVar: string) => string;
      searchProviderApiKeyConfigured: string;
      searchReaderBackend: string;
      searchPlanning: string;
      desktopNotifications: string;
      desktopNotificationAssistantMessages: string;
      desktopNotificationTaskCompletions: string;
      desktopTray: string;
      developerMode: string;
    };
    nativeNotifications: {
      status: {
        checking: string;
        unsupported: string;
        macosPermission: string;
        windowsShortcut: string;
        linuxLibnotify: string;
        platformDependent: string;
        browserUnsupported: string;
        unavailable: string;
      };
      settings: {
        macos: string;
        windows: string;
        fallback: string;
      };
    };
    systemEventLabels: {
      titles: {
        consolidation: string;
        profile: string;
        sessionSync: string;
        contextMaintenance: string;
        consolidationCycle: string;
      };
      statuses: {
        ok: string;
        completed: string;
        failed: string;
        running: string;
        notRun: string;
        unknown: string;
      };
      metrics: Record<string, string>;
      values: {
        yes: string;
        no: string;
        deep: string;
        basic: string;
        off: string;
      };
    };
    actions: {
      chooseFolder: string;
      applyPersonalization: string;
      savePersonalization: string;
      clearProfile: string;
      clearProfileQueued: string;
      openProfileMigration: string;
      closeProfileMigration: string;
      copyMigrationPrompt: string;
      importProfileMigration: string;
      importProfileMigrationRunning: string;
      addMcpServer: string;
      testMcpServer: string;
      editMcpServer: string;
      deleteMcpServer: string;
      enableMcpServer: string;
      disableMcpServer: string;
      importSkill: string;
      createSkillWithChat: string;
      checkUpdates: string;
      updateComponent: string;
      upToDate: string;
      updateChecking: string;
      updateApplying: string;
    };
    placeholders: {
      butlerNickname: string;
      principalName: string;
      preferredAddress: string;
      profileMigrationDump: string;
      persona: string;
      eol: string;
      mcpArgs: string;
      mcpEnv: string;
      mcpHeaders: string;
    };
    errors: {
      loadPersonalization: string;
      updateSettings: string;
      chooseFolder: string;
      updatePersonalization: string;
      profileMigration: string;
      profileMigrationProfilingOff: string;
      updateLocalReasoningBudget: string;
      loadAppInfo: string;
      updateDeveloperMode: string;
    };
    localModels: {
      title: string;
      description: string;
      provider: string;
      apiInfoTitle: string;
      modelInfoTitle: string;
      apiType: string;
      apiDescription: string;
      platformHint: string;
      serverUrl: string;
      discoverModels: string;
      discovering: string;
      registerModel: string;
      registering: string;
      saveModel: string;
      saving: string;
      showAdvanced: string;
      hideAdvanced: string;
      unsavedChanges: string;
      discoveredModel: string;
      discoveredModelDescription: string;
      manualFallback: string;
      modelId: string;
      displayName: string;
      maxContext: string;
      registeredLocalModels: string;
      customOpenAiCompatible: string;
      discoveredStatus: (count: number) => string;
      registeredStatus: (modelName: string) => string;
      savedStatus: (modelName: string) => string;
      editingStatus: (modelName: string) => string;
      deleteConfirm: (modelName: string) => string;
      deletedStatus: (modelName: string) => string;
      editLabel: (modelName: string) => string;
      deleteLabel: (modelName: string) => string;
      reasoningBudgetLabel: (percent: string) => string;
      errors: {
        discover: string;
        register: string;
        update: string;
        delete: string;
      };
    };
    modelManagement: {
      title: string;
      addTitle: string;
      editTitle: string;
      manageButton: string;
      addButton: string;
      registeredTitle: string;
      emptyRegistered: string;
      provider: string;
      model: string;
      authMethod: string;
      apiKey: string;
      credential: string;
      credentialLabel: string;
      newCredential: string;
      codexOauth: string;
      apiKeyAuth: string;
      save: string;
      saveAdd: string;
      saveEdit: string;
      saving: string;
      edit: string;
      delete: string;
      deleteConfirm: (modelName: string) => string;
      registeredStatus: (modelName: string) => string;
      deletedStatus: (modelName: string) => string;
      editLabel: (modelName: string) => string;
      deleteLabel: (modelName: string) => string;
      authTag: (authType: string, credential: string) => string;
      errors: {
        save: string;
        delete: string;
      };
    };
  };
  titlebar: {
    commandPalette: string;
    hideRightPanel: string;
    showRightPanel: string;
  };
  commandPalette: {
    label: string;
    placeholder: string;
    close: string;
  };
}

const koKrCopy: AppCopy = {
  conversation: {
    work: {
      historyRegionLabel: "진행 내역",
      pendingLabel: "요청을 처리하고 있습니다.",
      pendingStateLabels: {
        accepted: "요청을 접수했습니다.",
        queued: "대기 중입니다.",
        thinking: "생각 중입니다.",
        streaming: "응답을 작성하고 있습니다.",
        waiting_for_form: "입력을 기다리고 있습니다.",
        waiting_for_tool: "도구 응답을 기다리고 있습니다.",
        retrying: "다시 시도하고 있습니다.",
        cancelling: "중지하고 있습니다.",
      },
      todoListRegionLabel: "진행 단계",
      todoListTitle: "진행 단계",
      todoItemPendingLabel: "대기",
      todoItemRunningLabel: "진행 중",
      todoItemCompletedLabel: "완료",
      todoItemFailedLabel: "실패",
      todoItemCancelledLabel: "취소",
      collapsedSummary: (primaryLabel, count) =>
        count <= 1
          ? primaryLabel
          : `${primaryLabel} 외 ${count - 1}개 진행 내역`,
      expandHistoryLabel: (primaryLabel, count) =>
        count <= 1
          ? `${primaryLabel} 세부 내역 열기`
          : `${primaryLabel} 외 ${count - 1}개 진행 내역 열기`,
      collapseHistoryLabel: (primaryLabel, count) =>
        count <= 1
          ? `${primaryLabel} 세부 내역 닫기`
          : `${primaryLabel} 외 ${count - 1}개 진행 내역 닫기`,
      toolchainRegionLabel: (label) => `${label} 도구 실행 내역`,
      detailsRegionLabel: (label) => `${label} 세부 내역`,
      webSearchSummary: (count) => `Web search ${count} queries`,
      toolStepsSummary: (toolName, count) => `${toolName} ${count} steps`,
      webSearchDetail: (value) => `Web search: ${value}`,
      detailRow: (label, value) => `${label}: ${value}`,
    },
    result: {
      regionLabel: "답변",
    },
    failure: {
      regionLabel: "실패한 응답",
      title: "요청을 끝까지 완료하지 못했습니다.",
      retry: "다시 시도",
      retrying: "다시 시도 중",
      fallbackReason: "안전한 오류 내용을 확인할 수 없습니다.",
    },
  },
  sessionActions: {
    menuLabel: "세션 메뉴",
    rename: "이름 바꾸기",
    archive: "보관하기",
    renameTitle: "세션 이름 바꾸기",
    renameField: "세션 이름",
    cancel: "취소",
    save: "저장",
  },
  sidebar: {
    regionLabel: "사이드바",
    newChat: "새 대화",
    search: "검색",
    automations: "자동화",
    projects: "프로젝트",
    chats: "대화",
    settings: "설정",
    expandProjects: "프로젝트 펼치기",
    collapseProjects: "프로젝트 접기",
    expandChats: "대화 펼치기",
    collapseChats: "대화 접기",
    newProject: "새 프로젝트",
    startFromScratch: "처음부터 시작",
    useExistingFolder: "기존 폴더 사용",
    availableInDesktop: "데스크톱 앱에서 사용 가능",
    projectDashboard: "프로젝트 대시보드",
    newProjectChat: "새 프로젝트 대화",
    projectMenu: "프로젝트 메뉴",
    projectRenameTitle: "프로젝트 이름 바꾸기",
    projectName: "프로젝트 이름",
    pin: "고정",
    unpin: "고정 해제",
    delete: "삭제",
    projectDeleteConfirm: (projectName) =>
      `"${projectName}" 프로젝트를 Butler에서 영구 삭제할까요? 로컬 폴더는 삭제하지 않습니다.`,
  },
  composer: {
    messageComposer: "메시지 입력",
    placeholder: "Butler에게 무엇이든 물어보세요",
    placeholderFollowUp: "후속 변경사항 요청",
    attachedFiles: "첨부 파일",
    removeFile: (fileName) => `${fileName} 제거`,
    attachFile: "파일 첨부",
    permission: "권한",
    plan: "계획",
    model: "모델",
    modelSearch: "Search models...",
    modelSearchClear: "Clear search",
    allProviders: "All",
    noModels: "No models found",
    reasoning: "추론",
    reasoningEffort: "추론 강도",
    send: "전송",
    stop: "중지",
    queuedMessages: "대기 중인 메시지",
    queuedMessage: "대기 중인 메시지",
    queuedMessageStatus: "대기 중",
    queuedAttachmentCount: (count) => `첨부 ${count}개`,
    editQueuedMessage: "대기 메시지 수정",
    deleteQueuedMessage: "대기 메시지 삭제",
    contextDetails: "컨텍스트 세부정보 표시",
  },
  permissions: {
    fullAccess: "전체 권한",
    fullAccessDesc: "파일 읽기, 쓰기, 명령 실행 가능",
    askFirst: "먼저 확인",
    askFirstDesc: "수정 전 사용자 승인 필요",
    readOnly: "읽기 전용",
    readOnlyDesc: "파일 읽기만 가능",
  },
  automations: {
    title: "자동화",
    scheduledCount: (count) => `예약된 프롬프트 ${count}개`,
    empty: "아직 자동화가 없습니다",
    new: "새 자동화",
    detailFallback: "상세",
    backLabel: "자동화 목록으로 돌아가기",
    runNow: "지금 실행",
    resume: "재개",
    pause: "일시정지",
    fields: {
      title: "제목",
      prompt: "프롬프트",
      details: "세부 정보",
      targetChat: "대상 대화",
      interval: "간격",
      customMinutes: "사용자 지정 분",
      state: "상태",
      runs: "실행 기록",
    },
    placeholders: {
      title: "자동화 제목",
      prompt: "프롬프트 내용",
    },
    runs: {
      empty: "아직 실행 기록이 없습니다",
      queued: "대기 중",
      succeeded: "성공",
      failed: "실패",
      running: "실행 중",
      skippedTargetUnavailable: "대상을 사용할 수 없음",
      cancelled: "취소됨",
      notRun: "실행 전",
    },
    inspector: {
      empty: "이 세션을 대상으로 하는 자동화가 없습니다",
    },
  },
  artifacts: {
    title: "아티팩트",
    empty: "아직 아티팩트가 없습니다",
    backToList: "아티팩트 목록",
    open: "열기",
    save: "저장하기",
    saved: "아티팩트를 저장했습니다",
    saveFailed: "아티팩트를 저장하지 못했습니다",
    loading: "아티팩트를 불러오는 중",
    unsupported: "앱 안에서 미리 볼 수 없는 아티팩트입니다",
    loadFailed: "아티팩트를 불러오지 못했습니다",
  },
  inspector: {
    tabs: {
      summary: "요약",
      context: "맥락",
      artifacts: "아티팩트",
      automations: "자동화",
      workers: "작업자",
    },
    workers: {
      showDetails: "상세",
      hideDetails: "닫기",
    },
  },
  common: {
    close: "닫기",
    more: "더보기",
    refresh: "새로고침",
    save: "저장",
    cancel: "취소",
    delete: "삭제",
    copy: "복사",
  },
  settings: {
    title: "설정",
    back: "돌아가기",
    saving: "저장 중",
    saved: "저장됨",
    sectionsLabel: "설정 섹션",
    sections: {
      general: "일반",
      notifications: "알림",
      desktopShell: "데스크톱",
      models: "모델",
      appearance: "화면",
      server: "서버",
      updates: "업데이트",
      mcp: "MCP",
      skills: "스킬",
      usage: "사용량",
      personalization: "개인화",
      privacy: "개인정보",
      system: "시스템 이벤트",
      archives: "아카이브",
      about: "정보",
    },
    panels: {
      butlerModel: "모델 설정",
      workerModelRules: "작업자 모델 규칙",
      serverBridge: "서버 / 브리지",
      updates: "업데이트",
      mcpServers: "MCP 서버",
      skills: "스킬",
      usageMonitor: "사용량",
      privacyDiagnostics: "개인정보 / 진단",
      systemEvents: "시스템 이벤트",
      archives: "아카이브",
      about: "앱 정보",
    },
    fields: {
      language: "언어",
      timezone: "타임존",
      followUpBehavior: "후속 요청 처리",
      multilineSend: "메시지 보내기",
      searchSettings: "검색",
      searchProvider: "검색 제공자",
      searchProviderApiKey: "API key",
      searchReaderBackend: "페이지 읽기",
      searchPlanningEnabled: "스마트 검색계획 사용",
      searchDefaultDepth: "기본 검색 깊이",
      butlerModel: "모델",
      butlerReasoning: "추론",
      consolidationModel: "대화 기억 정리 모델",
      localReasoningBudget: "로컬 추론 예산",
      contextLimit: "컨텍스트 한도",
      access: "접근 권한",
      planModeDefault: "기본으로 계획 모드 사용",
      enabled: "사용",
      condition: "조건",
      model: "모델",
      reasoning: "추론",
      theme: "테마",
      mainScreenTheme: "메인화면 테마",
      mainScreenThemePreset: "배경 색상",
      mainScreenThemeColors: "사용자 지정 색상",
      mainScreenThemeColor: (index) => `색상 ${index}`,
      themeSamples: "테마 예시",
      translucentSidebar: "투명 사이드바",
      desktopNotifications: "데스크톱 알림",
      desktopNotificationAssistantMessages: "AI 메시지 알림",
      desktopNotificationTaskCompletions: "작업 완료 알림",
      desktopTray: "트레이 / 메뉴바 표시",
      bridgeMode: "브리지 모드",
      serverUrl: "서버 URL",
      defaultProjectFolder: "기본 프로젝트 폴더",
      diagnostics: "진단",
      appName: "앱 이름",
      appVersion: "버전",
      appRepository: "GitHub 저장소",
      appProtocol: "프로토콜",
      developerMode: "개발자 모드",
      butlerNickname: "버틀러 닉네임",
      principalName: "내 이름",
      preferredAddress: "나를 부를 호칭",
      profilingMode: "사용자 정보 분석",
      profilingExtractorModel: "사용자 정보 분석 모델",
      profileMigrationImport: "외부 AI 기억 가져오기",
      profileMigrationPrompt: "가져오기 프롬프트",
      profileMigrationDump: "가져온 프로필 내용",
      personaPreset: "페르소나 프리셋",
      persona: "페르소나",
      eol: "EOL",
      mcpServerId: "서버 ID",
      mcpServerName: "표시 이름",
      mcpTransport: "연결 방식",
      mcpCommand: "명령",
      mcpArgs: "인자",
      mcpUrl: "URL",
      mcpCwd: "작업 폴더",
      mcpEnv: "환경 변수",
      mcpHeaders: "헤더",
    },
    options: {
      english: "영어",
      korean: "한국어",
      queueWhileBusy: "작업 중이면 대기열에 추가",
      steerCurrentTurn: "현재 작업 방향 조정",
      modifierEnterSendEnterNewline: "Command/Ctrl Enter 전송, Enter 줄바꿈",
      enterSendShiftEnterNewline: "Enter 전송, Shift Enter 줄바꿈",
      system: "시스템",
      light: "라이트",
      dark: "다크",
      mainScreenThemeNone: "None",
      mainScreenThemeBloom: "Bloom",
      mainScreenThemeSilk: "Silk",
      paletteMonochrome: "Monochrome",
      paletteAurora: "Aurora",
      paletteBloom: "Bloom",
      paletteLavender: "Lavender",
      paletteMorning: "Morning",
      paletteCustom: "직접 지정",
      local: "로컬",
      external: "외부",
      customPersona: "직접 편집",
      profilingOff: "끄기",
      profilingBasic: "기본",
      profilingDeep: "깊게",
      profilingExtractorDefault: "모델 기본값",
      consolidationModelDefault: "모델 기본값",
      stdio: "stdio",
      http: "Streamable HTTP",
      sse: "SSE",
      searchProviderDuckDuckGo: "DuckDuckGo HTML",
      searchProviderAuto: "자동",
      searchProviderBrave: "Brave Search",
      searchProviderTavily: "Tavily",
      searchProviderOpenAi: "OpenAI Web Search",
      searchProviderCodex: "Codex 구독 검색",
      searchProviderDisabled: "비활성화",
      searchReaderLightweight: "경량 리더",
      searchReaderAuto: "자동",
      searchReaderLightpanda: "Lightpanda",
      searchReaderJina: "Jina Hosted",
      searchReaderDisabled: "비활성화",
      searchDepthQuick: "빠르게",
      searchDepthBalanced: "균형",
      searchDepthDeep: "깊게",
      timezoneSearch: "타임존 검색",
      timezoneSearchClear: "검색 지우기",
      timezoneAll: "전체",
      timezoneEmpty: "일치하는 타임존이 없습니다",
    },
    descriptions: {
      runtimeSupportedModelsOnly:
        "현재 실행 가능한 제공자의 모델만 표시합니다.",
      language: "버틀러 앱의 인터페이스 언어를 설정합니다",
      timezone:
        "버틀러가 현재 시간과 일정 맥락을 해석할 때 사용할 타임존입니다.",
      consolidationModel:
        "대화 기억 정리와 사용자 정보 분석에서 사용할 모델입니다.",
      consolidationModelDefault:
        "현재 버틀러 기본 모델 설정을 그대로 따릅니다.",
      localReasoningBudget:
        "선택한 로컬 모델의 최대 출력 토큰 중 추론에 사용할 비율입니다.",
      mainScreenTheme: "새 채팅 첫 화면에 적용할 배경 테마입니다.",
      mainScreenThemePreset: "메인화면 배경에 사용할 색상 조합을 고릅니다.",
      mainScreenThemeColors:
        "직접 지정한 색상이 메인화면 배경의 흐름에 사용됩니다.",
      contextLimit: (maxLabel) =>
        `실제 버틀러 컨텍스트 예산입니다. 모델 최대값: ${maxLabel}.`,
      contextLimitClamped: (value) =>
        `컨텍스트 한도를 ${value} 토큰으로 조정했습니다.`,
      personaPreset:
        "프리셋을 고르면 아래 페르소나 초안만 바뀌고, 적용 전에는 저장되지 않습니다.",
      profilingMode:
        "동의하면 로컬 대화에서 맞춤 응답에 필요한 정보를 저장하고 활용합니다.",
      profilingOff:
        "사용자 정보를 분석하지 않습니다. 기능상 필요한 현재 설정만 사용합니다.",
      profilingBasic:
        "말투, 설명 방식, 작업 방식 선호를 맞춤 응답에 사용합니다.",
      profilingDeep:
        "최근 관심사, 의미 있는 맥락, 가치 판단까지 맞춤 응답에 사용합니다.",
      profilingExtractorModel:
        "개인화에 필요한 정보를 읽어낼 때 사용할 모델입니다.",
      profilingExtractorDefault:
        "현재 버틀러 기본 모델 설정을 그대로 따릅니다.",
      profileMigration: "외부 AI 서비스에서 기억을 가져올 수 있습니다.",
      profileMigrationImmediate:
        "가져오기를 누르면 이 화면에서 바로 처리되며, 완료되면 결과가 표시됩니다.",
      profileMigrationImporting:
        "가져온 기억을 읽고 프로필에 반영하는 중입니다.",
      profileMigrationApplied: (count) =>
        `가져오기가 완료되었습니다. ${count}개 정보를 프로필에 반영했고, 다음 답변부터 사용됩니다.`,
      profileMigrationStored:
        "가져온 내용은 저장되었습니다. 다음 답변에 사용할 만큼 확실한 정보가 생기면 반영됩니다.",
      profileMigrationNoNewInfo:
        "가져오기는 끝났지만 새로 반영할 정보는 찾지 못했습니다.",
      systemEvents:
        "정기 정리, 사용자 정보 분석, 유지보수 작업이 언제 어떻게 끝났는지 확인합니다.",
      systemEventsEmpty: "아직 표시할 시스템 이벤트가 없습니다.",
      updates: "앱, 앱 서버, 버틀러 서비스를 각각 확인하고 업데이트합니다.",
      eolLastLoaded: (value) => `마지막으로 불러온 시각 ${value}`,
      mcpServers:
        "설정은 Butler data home에 저장되고, 활성 서버의 도구와 리소스는 버틀러가 대화 중 바로 호출할 수 있습니다.",
      mcpSecrets:
        "값의 출처, 키, 값을 행 단위로 입력합니다. 필요하면 같은 출처를 전체 행에 적용할 수 있고, 저장된 값은 화면과 API 응답에서 숨깁니다.",
      skills:
        "기본 스킬과 프로젝트 스킬을 Butler data home 기준으로 관리합니다.",
      usageMonitor:
        "모델 토큰, 프롬프트 캐시, 웹 검색, 도구 호출을 확인합니다. 컨텍스트 창 용량과는 별도로 기록됩니다.",
      usageMonitorEmpty: "아직 표시할 사용량 기록이 없습니다.",
      searchSettings:
        "웹 검색 제공자와 검색 전 계획 방식을 설정합니다. 키가 필요한 제공자는 이 화면에서 비밀값으로 저장할 수 있습니다.",
      searchProvider:
        "실제 검색 결과를 가져올 백엔드를 선택합니다. 키가 필요한 제공자는 키가 없으면 안전한 기본 검색으로 내려갑니다.",
      searchProviderApiKey: (envVar) =>
        `${envVar}에 저장합니다. 값은 화면과 API 응답에 다시 노출하지 않습니다.`,
      searchProviderApiKeyConfigured:
        "저장된 키 있음. 새 값을 입력하면 교체됩니다.",
      searchReaderBackend: "검색 결과 원문을 읽을 때 사용할 페이지 리더입니다.",
      searchPlanning:
        "켜면 검색 전에 모델을 한 번 호출해 의도, 깊이, 검증 필요성, 쿼리 묶음을 계획합니다. 형식 오류가 나면 한 번 재시도한 뒤 직접 검색합니다.",
      desktopNotifications:
        "앱이 뒤에 있을 때 새 답변이나 작업 완료 상태를 운영체제 알림으로 보냅니다.",
      desktopNotificationAssistantMessages:
        "새 AI 답변이 도착하면 안전한 미리보기만 알림에 표시합니다.",
      desktopNotificationTaskCompletions:
        "진행 중인 작업이 완료, 실패, 취소 상태가 되면 알림을 보냅니다.",
      desktopTray:
        "켜면 창을 닫아도 앱이 트레이 또는 메뉴바에 남고, 메뉴에서 새 대화와 최근 대화를 열 수 있습니다.",
      developerMode:
        "켜면 이 데스크톱 앱 창에서 Chrome DevTools를 열 수 있습니다. 끄면 Electron 기본 메뉴와 DevTools 단축키가 차단됩니다.",
    },
    nativeNotifications: {
      status: {
        checking: "Electron 알림 브리지를 확인 중입니다.",
        unsupported: "이 환경에서는 데스크톱 알림을 지원하지 않습니다.",
        macosPermission:
          "macOS 알림 권한이 꺼져 있으면 시스템 설정에서 Butler 알림을 허용해야 합니다.",
        windowsShortcut:
          "Windows 알림이 꺼져 있으면 시스템 알림 설정에서 Butler 알림을 허용해야 합니다.",
        linuxLibnotify:
          "Linux 알림은 데스크톱 환경과 libnotify 지원 여부에 따라 달라집니다.",
        platformDependent:
          "알림 권한 상태는 운영체제 설정에 따라 달라질 수 있습니다.",
        browserUnsupported:
          "데스크톱 알림 브리지는 Electron 앱에서만 사용할 수 있습니다.",
        unavailable: "알림 상태를 확인할 수 없습니다.",
      },
      settings: {
        macos: "macOS 알림 설정",
        windows: "Windows 알림 설정",
        fallback: "시스템 설정",
      },
    },
    systemEventLabels: {
      titles: {
        consolidation: "대화 기억 정리",
        profile: "사용자 정보 분석",
        sessionSync: "대화 기록 반영",
        contextMaintenance: "컨텍스트 정리",
        consolidationCycle: "정기 기억 정리",
      },
      statuses: {
        ok: "성공",
        completed: "완료",
        failed: "실패",
        running: "실행 중",
        notRun: "아직 실행 전",
        unknown: "상태 확인 필요",
      },
      metrics: {
        phase_count: "단계",
        failed_phase_count: "실패 단계",
        profiling_enabled: "사용자 정보 분석",
        mode: "모드",
        candidate_count: "후보",
        promoted_count: "반영",
        skipped_count: "제외",
        stable_entry_count: "저장된 프로필",
        projection_written: "투영본 갱신",
        transcript_scanned_file_count: "읽은 대화 파일",
        transcript_scanned_event_count: "읽은 이벤트",
        transcript_captured_candidate_count: "대화에서 찾은 후보",
        transcript_extractor_model_called: "모델 호출",
        transcript_extractor_fallback_used: "대체 경로",
        last_run_date: "실행일",
      },
      values: {
        yes: "예",
        no: "아니오",
        deep: "깊게",
        basic: "기본",
        off: "끔",
      },
    },
    actions: {
      chooseFolder: "폴더 선택",
      applyPersonalization: "적용",
      savePersonalization: "개인화 저장",
      clearProfile: "프로필 데이터 삭제",
      clearProfileQueued: "삭제 예정",
      openProfileMigration: "가져오기",
      closeProfileMigration: "닫기",
      copyMigrationPrompt: "프롬프트 복사",
      importProfileMigration: "프로필 가져오기",
      importProfileMigrationRunning: "가져오는 중",
      addMcpServer: "MCP 서버 추가",
      testMcpServer: "연결 확인",
      editMcpServer: "수정",
      deleteMcpServer: "삭제",
      enableMcpServer: "활성화",
      disableMcpServer: "비활성화",
      importSkill: "가져오기",
      createSkillWithChat: "대화해서 만들기",
      checkUpdates: "확인",
      updateComponent: "업데이트",
      upToDate: "최신",
      updateChecking: "확인 중",
      updateApplying: "적용 중",
    },
    placeholders: {
      butlerNickname: "예: Butler, 알프레드",
      principalName: "예: 사용할 이름",
      preferredAddress: "예: 선생님, 대표님",
      profileMigrationDump:
        "다른 AI가 돌려준 JSON 또는 요약 내용을 붙여넣으세요.",
      persona: "Butler가 자신을 표현하고 사용자와 협업하는 방식",
      eol: "장기 선호, 경계, 오래 유지할 운영 메모",
      mcpArgs: "한 줄에 하나씩 입력",
      mcpEnv: "OPENAI_API_KEY=env:OPENAI_API_KEY 또는 TOKEN=literal-value",
      mcpHeaders:
        "Authorization=env:MCP_AUTH_HEADER 또는 Authorization=Bearer ...",
    },
    errors: {
      loadPersonalization: "개인화 불러오기 실패",
      updateSettings: "설정 업데이트 실패",
      chooseFolder: "폴더 선택 실패",
      updatePersonalization: "개인화 업데이트 실패",
      profileMigration: "프로필 가져오기 실패",
      profileMigrationProfilingOff:
        "사용자 정보 분석이 꺼져 있어 가져온 내용을 반영하지 않았습니다.",
      updateLocalReasoningBudget: "로컬 추론 예산 업데이트 실패",
      loadAppInfo: "앱 정보 불러오기 실패",
      updateDeveloperMode: "개발자 모드 변경 실패",
    },
    localModels: {
      title: "로컬 모델",
      description:
        "버틀러와 작업자 모델 선택기에 OpenAI 호환 로컬 서버를 등록합니다.",
      provider: "제공자",
      apiInfoTitle: "모델 API 정보",
      modelInfoTitle: "모델 정보",
      apiType: "API 유형",
      apiDescription:
        "API 표준을 우선 사용하고, 플랫폼은 호환성 힌트로만 사용합니다.",
      platformHint: "플랫폼 힌트",
      serverUrl: "서버 URL",
      discoverModels: "모델 찾기",
      discovering: "찾는 중",
      registerModel: "모델 등록",
      registering: "등록 중",
      saveModel: "모델 저장",
      saving: "저장 중",
      showAdvanced: "설정 더보기",
      hideAdvanced: "설정 접기",
      unsavedChanges:
        "저장하지 않은 변경사항이 있습니다. 페이지를 벗어나면 변경사항이 사라집니다.",
      discoveredModel: "찾은 모델",
      discoveredModelDescription:
        "사용할 수 있으면 서버 실행 창을 기본 컨텍스트로 사용합니다.",
      manualFallback: "수동 입력",
      modelId: "모델 ID",
      displayName: "표시 이름",
      maxContext: "최대 컨텍스트",
      registeredLocalModels: "등록된 로컬 모델",
      customOpenAiCompatible: "사용자 지정 OpenAI 호환",
      discoveredStatus: (count) => `로컬 모델 ${count}개를 찾았습니다.`,
      registeredStatus: (modelName) => `${modelName} 모델을 등록했습니다.`,
      savedStatus: (modelName) => `${modelName} 모델을 저장했습니다.`,
      editingStatus: (modelName) => `${modelName} 모델을 편집 중입니다.`,
      deleteConfirm: (modelName) =>
        `${modelName} 모델을 로컬 모델에서 삭제할까요?`,
      deletedStatus: (modelName) => `${modelName} 모델을 삭제했습니다.`,
      editLabel: (modelName) => `${modelName} 편집`,
      deleteLabel: (modelName) => `${modelName} 삭제`,
      reasoningBudgetLabel: (percent) => `${percent}% 추론`,
      errors: {
        discover: "로컬 모델 검색 실패",
        register: "로컬 모델 등록 실패",
        update: "로컬 모델 업데이트 실패",
        delete: "로컬 모델 삭제 실패",
      },
    },
    modelManagement: {
      title: "모델 관리",
      addTitle: "모델 추가",
      editTitle: "모델 편집",
      manageButton: "모델 관리",
      addButton: "모델 추가",
      registeredTitle: "등록된 모델",
      emptyRegistered: "아직 등록된 모델이 없습니다.",
      provider: "제공자",
      model: "모델",
      authMethod: "인증 방식",
      apiKey: "API key",
      credential: "저장된 인증",
      credentialLabel: "인증 이름",
      newCredential: "새로 작성",
      codexOauth: "OAuth",
      apiKeyAuth: "API key",
      save: "추가",
      saveAdd: "추가",
      saveEdit: "저장",
      saving: "저장 중",
      edit: "편집",
      delete: "삭제",
      deleteConfirm: (modelName) =>
        `${modelName} 모델을 선택 가능 목록에서 삭제할까요?`,
      registeredStatus: (modelName) => `${modelName} 모델을 등록했습니다.`,
      deletedStatus: (modelName) => `${modelName} 모델을 삭제했습니다.`,
      editLabel: (modelName) => `${modelName} 편집`,
      deleteLabel: (modelName) => `${modelName} 삭제`,
      authTag: (authType, credential) => `${authType} · ${credential}`,
      errors: {
        save: "모델 등록 실패",
        delete: "모델 삭제 실패",
      },
    },
  },
  titlebar: {
    commandPalette: "명령 팔레트",
    hideRightPanel: "오른쪽 패널 숨기기",
    showRightPanel: "오른쪽 패널 보기",
  },
  commandPalette: {
    label: "명령 팔레트",
    placeholder: "대화, 프로젝트, 자동화, 설정 검색",
    close: "명령 팔레트 닫기",
  },
};

const appCopyByLocale: Record<AppLocale, AppCopy> = {
  "ko-KR": koKrCopy,
};

const defaultAppLocale: AppLocale = "ko-KR";

export function getAppCopy(locale: AppLocale = defaultAppLocale): AppCopy {
  return appCopyByLocale[locale];
}

export const appCopy = getAppCopy();
