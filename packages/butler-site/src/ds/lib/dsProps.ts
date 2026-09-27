/**
 * Strong-constraint DS: components never accept className or style.
 * Style through variant, size and tone props instead.
 */
export type DsBaseProps<T> = Omit<T, "className" | "style" | "dangerouslySetInnerHTML">;
