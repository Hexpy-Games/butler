

export const named = (live: boolean) => (name: string) => (live ? name : undefined);
