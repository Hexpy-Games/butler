export function waitForClose(register: (onClose: () => void) => void): Promise<void> {
  return new Promise<void>((resolve) => register(resolve));
}
