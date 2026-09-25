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

/** Shape of a co-located `<Name>.showcase.tsx` module. */
export interface ShowcaseModule {
  meta: ShowcaseMeta;
  stories: ShowcaseStory[];
}
