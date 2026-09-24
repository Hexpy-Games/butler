import { useAppLocale } from "@/app/copy.ts";
import { Children, isValidElement, type ReactNode } from "react";
import { MessageFooter, useScrollEdges } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import { CopyTextButton } from "./CopyTextButton";
import styles from "./MarkdownCodeBlock.module.css";

export function MarkdownCodeBlock({ children }: { children?: ReactNode }) {
  useAppLocale();
  const preFadeRef = useScrollEdges("x");
  const code = Children.toArray(children).map((child) => {
    if (isValidElement<{ children?: ReactNode }>(child)) {
      return typeof child.props.children === "string" ? child.props.children : "";
    }
    return typeof child === "string" ? child : "";
  }).join("");
  return (
    <div className={styles.block}>
      <MessageFooter dataTestClass="code-block-actions">
        <CopyTextButton text={code} label={appCopy.conversation.messageActions.copyCode} />
      </MessageFooter>
      <pre ref={preFadeRef}>{children}</pre>
    </div>
  );
}
