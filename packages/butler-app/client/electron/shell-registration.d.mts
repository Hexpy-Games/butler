export function shellRegistrationAllowed(input: {
  isPackaged: boolean;
  env: Record<string, string | undefined>;
  home: string;
  dataRoot: string;
}): boolean;
