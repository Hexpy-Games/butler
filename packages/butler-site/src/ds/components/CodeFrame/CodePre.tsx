import type { ReactNode } from "react";
import { CodeFrame } from "./CodeFrame";

/** MDX `pre` override: Shiki's highlighted <pre> becomes a CodeFrame. */
export function CodePre(props: { "data-language"?: string; children?: ReactNode }) {
  const language = props["data-language"];
  return <CodeFrame language={language === "plaintext" ? "" : language}>{props.children}</CodeFrame>;
}
