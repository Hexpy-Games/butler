export interface NativeContextMenuCopy {
  openInNewTab: string;
  openInButler: string;
  openInBrowser: (name: string) => string;
  copyLink: string;
  copy: string;
  selectAll: string;
  paste: string;
}

export function nativeContextMenuCopy(language?: string | null): NativeContextMenuCopy;
