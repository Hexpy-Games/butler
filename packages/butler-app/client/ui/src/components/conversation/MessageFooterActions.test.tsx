/// <reference types="bun" />

import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { AssistantResponseFooter } from "./AssistantResponseFooter";
import { BranchMessageActions } from "./BranchMessageActions";
import { CopyTextButton } from "./CopyTextButton";

const iconButtons = (html: string) => html.match(/<button[^>]*class="[^"]*icon-button[^"]*"/gu) ?? [];

test("message footer actions use the DS IconButton", () => {
  expect(iconButtons(renderToStaticMarkup(<CopyTextButton text="x" label="Copy code" />))).toHaveLength(1);
  expect(iconButtons(renderToStaticMarkup(<BranchMessageActions sessionId="s" messageId="m" />))).toHaveLength(2);
  const footer = renderToStaticMarkup(<AssistantResponseFooter copied={false} onCopy={() => {}} meta={null} />);
  expect(iconButtons(footer)).toHaveLength(1);
});

test("the unused ComposerMenu role=menu stub is gone", () => {
  expect(existsSync(join(import.meta.dir, "ComposerMenu.tsx"))).toBe(false);
});
