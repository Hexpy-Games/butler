export interface Redactor {
  redact(value: unknown): unknown;
  remember(value: unknown, persistent?: boolean): void;
}
export function createRedactor(): Redactor;
