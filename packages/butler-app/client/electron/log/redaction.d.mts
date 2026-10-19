export interface Redactor {
  redact(value: unknown): unknown;
  remember(value: unknown): void;
  observe(value: unknown): void;
}
export function createRedactor(): Redactor;
