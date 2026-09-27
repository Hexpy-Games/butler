/** Components available in docs MDX without imports. */
import { CodePre } from "../ds/components/CodeFrame";
import { Kbd } from "../ds/components/Kbd";
import { Notice } from "../ds/components/Notice";
import { TableFrame } from "../ds/components/TableFrame";
import { TabPanel, Tabs } from "../ds/components/Tabs";
import CardGrid from "../ds/web/CardGrid/CardGrid.astro";
import DocCard from "../ds/web/DocCard/DocCard.astro";
import Steps from "../ds/web/Steps/Steps.astro";
import { DocLink } from "./DocLink";

export const mdxComponents = { a: DocLink, pre: CodePre, table: TableFrame, CardGrid, DocCard, Kbd, Notice, Steps, TabPanel, Tabs };
