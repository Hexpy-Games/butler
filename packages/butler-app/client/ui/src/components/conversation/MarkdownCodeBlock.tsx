import { useAppLocale } from "@/app/copy.ts";
import { Children, isValidElement, type ReactNode } from "react";
import { MessageFooter, Typo, useScrollEdges } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import { CopyTextButton } from "./CopyTextButton";
import { useSyntaxHighlight } from "./useSyntaxHighlight";
import styles from "./MarkdownCodeBlock.module.css";

type CodeChildProps = { children?: ReactNode; className?: string };

export function MarkdownCodeBlock({ children }: { children?: ReactNode }) {
  useAppLocale();
  const preFadeRef = useScrollEdges("x");
  const codeChildren = Children.toArray(children);
  const code = codeChildren.map((child) => {
    if (isValidElement<CodeChildProps>(child)) {
      return typeof child.props.children === "string" ? child.props.children : "";
    }
    return typeof child === "string" ? child : "";
  }).join("");
  const language = codeChildren
    .map((child) =>
      isValidElement<CodeChildProps>(child)
        ? /(?:^|\s)language-([\w+#.-]+)/u.exec(child.props.className ?? "")?.[1]
        : undefined)
    .find(Boolean);
  const highlighted = useSyntaxHighlight(code, language);
  const codeElement = codeChildren.find((child) => isValidElement<CodeChildProps>(child));
  const body = highlighted && isValidElement<CodeChildProps>(codeElement)
    ? <code className={codeElement.props.className}>{highlighted}</code>
    : children;
  return (
    <div className={styles.block} data-test-class="code-block">
      <div className={styles.header} data-test-class="code-block-header">
        <Typo.Code as="span" truncate>{language ?? ""}</Typo.Code>
        <MessageFooter dataTestClass="code-block-copy">
          <CopyTextButton text={code} label={appCopy.conversation.messageActions.copyCode} />
        </MessageFooter>
      </div>
      <pre ref={preFadeRef} className={styles.pre}>{body}</pre>
    </div>
  );
}
