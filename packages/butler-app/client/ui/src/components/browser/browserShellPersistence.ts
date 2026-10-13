interface ShellPreferences {
  chatWidth: number;
  conversations: Record<string, { open: boolean; lastTab?: string }>;
}

/** Explicit preferences projection: ephemeral browser media never reaches storage. */
export function persistedBrowserShell(state: ShellPreferences): ShellPreferences {
  return {
    chatWidth: state.chatWidth,
    conversations: Object.fromEntries(Object.entries(state.conversations).map(([id, tab]) =>
      [id, { open: tab.open, ...(tab.lastTab ? { lastTab: tab.lastTab } : {}) }])),
  };
}
