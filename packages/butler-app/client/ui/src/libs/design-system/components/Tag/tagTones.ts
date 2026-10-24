/**
 * Categorical label tones: colors that name a category (a user's tag), not a
 * status. Store the tone name, never a color value, so themes and wallpapers
 * restyle it.
 */
export const tagLabelTones = ["gray", "red", "orange", "yellow", "green", "teal", "blue", "purple"] as const;

export type TagLabelTone = (typeof tagLabelTones)[number];
