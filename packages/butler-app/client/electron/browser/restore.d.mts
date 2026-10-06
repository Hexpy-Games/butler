export function createTabRestore(directory: string, snapshot: () => string[]): {
  read(): Promise<string[]>; changed(): void; flush(): Promise<void>;
};
