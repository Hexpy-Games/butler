import type { ReactNode } from "react";
import type { AppLocale } from "../../../../../../../butler-i18n/src/index.ts";
import type { ShowcaseCategory } from "./categories";

export type { ShowcaseCategory } from "./categories";

export type ShowcaseStatus = "stable" | "beta" | "deprecated";

/** Preview widths offered by the DS Viewer toolbar. */
export type ShowcaseWidth = "320" | "375" | "430" | "app" | "wide";

export interface ShowcaseMeta {
  title: string;
  category: ShowcaseCategory;
  tags?: string[];
  status?: ShowcaseStatus;
}

export interface ShowcaseRenderContext {
  /** Example-content locale chosen in the viewer toolbar. */
  locale: AppLocale;
}

export interface ShowcaseStory {
  name: string;
  /** Rendered as a component body, so hooks are allowed. */
  render: (context: ShowcaseRenderContext) => ReactNode;
  /** Interaction states this story demonstrates, e.g. "hover", "disabled". */
  states?: string[];
  /** Preview widths this story is meant for; defaults to every width. */
  widths?: ShowcaseWidth[];
}

/**
 * Interaction states of the states matrix. `hover`, `focus-visible` and
 * `active` are forced through `data-ds-force-state` (the viewer rewrites the
 * matching pseudo-classes); `disabled`, `loading`, `selected`, `open` and
 * `invalid` are real props the story renders for its `state`.
 */
export const SHOWCASE_FORCED_STATES = ["hover", "focus-visible", "active"] as const;
export type ShowcaseForcedState = (typeof SHOWCASE_FORCED_STATES)[number];
export type ShowcaseState =
  | "default"
  | ShowcaseForcedState
  | "read-only"
  | "disabled"
  | "loading"
  | "selected"
  | "open"
  | "invalid";

export interface ShowcaseStateContext extends ShowcaseRenderContext {
  state: ShowcaseState;
  /** Row of the matrix, one of `variants` (or "default"). */
  variant: string;
}

/** Variants × states grid shown on the item page (S5 states matrix). */
export interface ShowcaseStateMatrix {
  states: ShowcaseState[];
  variants?: string[];
  render: (context: ShowcaseStateContext) => ReactNode;
}

export type ShowcaseRender = (context: ShowcaseRenderContext) => ReactNode;

/** "Use X instead": the situation and the DS export (or folder id) that fits it. */
export interface ShowcaseAlternative {
  when: string;
  use: string;
}

/** A live do/don't pair shown side by side. */
export interface ShowcaseDoDont {
  do: { caption: string; render: ShowcaseRender };
  dont: { caption: string; render: ShowcaseRender };
}

/**
 * A composition recipe. Its JSX is shown verbatim: the guidance file wraps the
 * render function in `// #region recipe: <name>` ... `// #endregion`.
 */
export interface ShowcaseRecipe {
  name: string;
  description: string;
  render: ShowcaseRender;
}

/** Usage guidance for one component or block (`<Name>.guidance.tsx`). */
export interface ShowcaseGuidance {
  /** One sentence: what it is for. */
  purpose: string;
  /** Needs this item answers; they also feed the decision guide ("I need X"). */
  whenToUse: string[];
  whenNotToUse: ShowcaseAlternative[];
  recipes: ShowcaseRecipe[];
  doDont: ShowcaseDoDont[];
  /** Copy length, tone, en/ko notes. */
  content: string[];
  accessibility: string[];
  /** Tokens it is built on (checked against tokens.css). */
  tokens: string[];
  /** Exported names that are composed internally and need no story, with the reason. */
  internalExports?: Record<string, string>;
}

/** Shape of a co-located `<Name>.showcase.tsx` module. */
export interface ShowcaseModule {
  meta: ShowcaseMeta;
  stories: ShowcaseStory[];
  stateMatrix?: ShowcaseStateMatrix;
}
