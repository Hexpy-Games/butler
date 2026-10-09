import type { IconSvgElement } from "@hugeicons/react";
// Named imports keep the bundle to the glyphs mapped below.
import {
  Alert02Icon, Album02Icon, Archive02Icon, Bookmark02Icon, CursorRectangleSelection01Icon, Download04Icon, Key01Icon,
  SquareArrowUpRightIcon, StarIcon,
} from "@hugeicons/core-free-icons";
import { createIcon } from "./iconBase";

const STROKE = { stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round", strokeWidth: "1.5" } as const;
const STAR_PATH = (StarIcon as unknown as Array<[string, { d: string }]>)[0]![1].d;

/** The Star outline, filled: a bookmarked page. */
const StarFilledGlyph = [["path", { d: STAR_PATH, fill: "currentColor", ...STROKE, key: "0" }]] as unknown as IconSvgElement;

/** A window with its tab bar and an arrow coming in: bring a tab into this conversation. */
const TabInGlyph = [
  ["rect", { x: "3", y: "5", width: "18", height: "15", rx: "3.5", ...STROKE, key: "0" }],
  ["path", { d: "M3 9.5H21", ...STROKE, key: "1" }],
  ["path", { d: "M12 12.5V17M9.75 14.75L12 17L14.25 14.75", ...STROKE, key: "2" }],
] as unknown as IconSvgElement;

// Browser glyphs (toolbar, page band, library), on the same grid and stroke as the rest of the set.
// ArrowRight (forward) aliases ChevronRight in Icons.tsx.
/** Pick elements on the page. */
export const Pick = createIcon(CursorRectangleSelection01Icon);
/** Scrap: keep a piece of a page in the library. */
export const Scrap = createIcon(Album02Icon);
export const Bookmark = createIcon(Bookmark02Icon);
export const Star = createIcon(StarIcon);
export const StarFilled = createIcon(StarFilledGlyph);
export const Download = createIcon(Download04Icon);
/** A pop-up window (opens outside the page card). */
export const Popup = createIcon(SquareArrowUpRightIcon);
/** Sign-ins and typed secrets (keypad, MFA, passkey). */
export const Key = createIcon(Key01Icon);
export const Warning = createIcon(Alert02Icon);
/** Library (서랍): scraps, picks and saved views. */
export const Library = createIcon(Archive02Icon);
export const TabIn = createIcon(TabInGlyph);
