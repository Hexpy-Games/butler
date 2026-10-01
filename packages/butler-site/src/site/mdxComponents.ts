/** Components available in docs MDX without imports. */
import { createElement, type ComponentProps } from "react";
import { CodePre } from "../ds/components/CodeFrame";
import { Kbd } from "../ds/components/Kbd";
import { Notice } from "../ds/components/Notice";
import { TableFrame } from "../ds/components/TableFrame";
import { TabPanel, Tabs } from "../ds/components/Tabs";
import CardGrid from "../ds/web/CardGrid/CardGrid.astro";
import DocCard from "../ds/web/DocCard/DocCard.astro";
import Steps from "../ds/web/Steps/Steps.astro";
import { DocLink } from "./DocLink";
import type { Locale } from "./sections";
import { ui } from "./ui";

/** The MDX component map for a locale: code blocks get that locale's copy-button label. */
export function mdxComponents(locale: Locale) {
  const copyLabel = ui(locale).page.copyCode;
  const pre = (props: ComponentProps<typeof CodePre>) => createElement(CodePre, { ...props, copyLabel });
  return { a: DocLink, pre, table: TableFrame, CardGrid, DocCard, Kbd, Notice, Steps, TabPanel, Tabs };
}
