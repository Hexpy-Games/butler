interface NativeWindowControlBridge {
  platform?: string;
  minimizeWindow?: () => Promise<unknown>;
  toggleWindowMaximize?: () => Promise<unknown>;
  closeWindow?: () => Promise<unknown>;
}

function nativeWindowBridge(): NativeWindowControlBridge | null {
  if (typeof window === "undefined") return null;
  return (window.butlerApp ?? null) as NativeWindowControlBridge | null;
}

export function shouldShowAppWindowControls(): boolean {
  const bridge = nativeWindowBridge();
  if (!bridge || bridge.platform === "darwin") return false;
  return Boolean(
    bridge.minimizeWindow &&
      bridge.toggleWindowMaximize &&
      bridge.closeWindow,
  );
}

export async function minimizeNativeWindow(): Promise<void> {
  await nativeWindowBridge()?.minimizeWindow?.();
}

export async function toggleNativeWindowMaximize(): Promise<void> {
  await nativeWindowBridge()?.toggleWindowMaximize?.();
}

export async function closeNativeWindow(): Promise<void> {
  await nativeWindowBridge()?.closeWindow?.();
}
