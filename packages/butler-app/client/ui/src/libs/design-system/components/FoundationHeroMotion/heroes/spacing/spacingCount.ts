import { UNIT } from "./spacingCopy";

/** 4px units a space holds. */
export const count = (px: number) => px / UNIT;

/** A space's count: `20 = 5×4`. */
export const sum = (px: number) => `${px} = ${count(px)}×${UNIT}`;
