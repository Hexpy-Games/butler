/** Display-only command parsing shared by tool activity and approval grants. */
export function commandProgram(command: string): string {
  const words = command.trim().match(/"[^"]*"|'[^']*'|\S+/gu) ?? [];
  const unquote = (value: string) => value.replace(/^["']|["']$/gu, "");
  const executable = unquote(words[0] ?? "").split(/[\\/]/u).at(-1) ?? "";
  if (/^(?:powershell|pwsh|cmd)(?:\.exe)?$/iu.test(executable)) {
    const flag = words.findIndex(word => /^(?:-command|-c|\/c|\/k)$/iu.test(word));
    if (flag >= 0) {
      const nested = words.slice(flag + 1).join(" ").replace(/^["']|["']$/gu, "").replace(/^&\s*/u, "");
      return commandProgram(nested) || executable;
    }
  }
  return executable;
}

export function uniqueFileTargets(target: string): string {
  return [...new Set(target.split(", ").map(value => value.trim()).filter(Boolean))].join(", ");
}
