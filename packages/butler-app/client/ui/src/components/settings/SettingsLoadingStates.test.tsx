/// <reference types="bun" />

import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { appCopy } from "@/app/copy.ts";
import { ArchivesSettings } from "./ArchivesSettings";
import { McpSettings } from "./McpSettings";
import { SkillsSettings } from "./SkillsSettings";

const skeleton = 'data-test-class="settings-list-skeleton"';

test("archives show a skeleton, not the empty message, before the first load", () => {
  const html = renderToStaticMarkup(<ArchivesSettings />);
  expect(html).toContain(skeleton);
  expect(html).not.toContain(appCopy.interfaceDetails.archivesEmpty);
});

test("skills show a skeleton, not empty groups, before the first load", () => {
  const html = renderToStaticMarkup(<SkillsSettings />);
  expect(html).toContain(skeleton);
  expect(html).not.toContain(appCopy.interfaceDetails.noSkills);
});

test("MCP servers show a skeleton, not the empty message, before the first load", () => {
  const html = renderToStaticMarkup(<McpSettings />);
  expect(html).toContain(skeleton);
  expect(html).not.toContain(appCopy.interfaceDetails.noMcp);
});
