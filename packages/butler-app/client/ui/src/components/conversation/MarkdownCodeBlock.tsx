import { Children, isValidElement, type ReactNode } from "react";
import { MessageFooter } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import { CopyTextButton } from "./CopyTextButton";
import styles from "./MarkdownCodeBlock.module.css";

export function MarkdownCodeBlock({ children }: { children?: ReactNode }) {
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
      <pre>{children}</pre>
    </div>
  );
}
