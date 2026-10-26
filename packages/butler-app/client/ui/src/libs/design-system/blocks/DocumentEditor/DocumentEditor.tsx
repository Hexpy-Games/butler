import type { HTMLAttributes, ReactNode, Ref } from "react";
import type { DsBaseProps } from "../../lib/dsProps";
import { dsClass } from "../../lib/internal";
import { cn } from "../../lib/utils";
import markdown from "../MarkdownContent/MarkdownContent.module.css";
import { OverflowActionMenu, type OverflowActionMenuItem } from "../OverflowActionMenu";
import styles from "./DocumentEditor.module.css";

export interface DocumentEditorProps extends Omit<DsBaseProps<HTMLAttributes<HTMLDivElement>>, "title"> {
  /** The document's title (a name field or a heading), centred on the control line it shares with `actions`. Null when a surrounding Dialog header already shows it. */
  title: ReactNode;
  /** One status line under the title: "버틀러가 수정 중", saved time. */
  note?: ReactNode;
  /** Document actions at the end of the title line (versions, export), inline wherever the line has room. */
  actions?: ReactNode;
  /** The same actions as flat ⋯ menu items: on a narrow title line they replace `actions`, so the title keeps the width. */
  menuActions?: OverflowActionMenuItem[];
  /** The ⋯ trigger's accessible name. */
  menuLabel?: string;
  /** The ⋯ menu's wrapper, to anchor a popover an item opens (and return focus to its trigger). */
  menuRef?: Ref<HTMLDivElement>;
  /** Host controls after the actions (close), visible at every width. */
  controls?: ReactNode;
  /** The editable body (a contenteditable root); it gets the document typography of MarkdownContent. */
  children: ReactNode;
  /** The floating DocumentFormatBar, rendered over the page. */
  formatBar?: ReactNode;
}

/**
 * A document being written: title line, status and the editable page in MarkdownContent's document
 * typography, so a document reads the same while edited as when read. The caller owns the editor engine;
 * `documentEditorClasses` names the classes its nodes take (headings, lists and block embeds need none
 * beyond their elements). Paragraphs Butler is changing take `data-butler-editing="true"`: a Butler-ink
 * wash and rule, faded in and out.
 */
export function DocumentEditor({ title, note, actions, menuActions, menuLabel, menuRef, controls, children, formatBar, className, ...props }: DocumentEditorProps) {
  const folds = Boolean(menuActions?.length);
  return (
    <div {...props} className={dsClass(styles.editor, className)} data-slot="document-editor">
      {title || actions || controls ? (
        <div className={styles.header}>
          <div className={styles.title}>{title}</div>
          {actions || controls ? (
            <div className={styles.actions} data-folds={folds ? "true" : undefined}>
              {actions ? <div className={styles.inline} data-slot="document-editor-actions">{actions}</div> : null}
              {folds ? <div ref={menuRef} className={styles.menu} data-slot="document-editor-menu"><OverflowActionMenu items={menuActions!} label={menuLabel} /></div> : null}
              {controls}
            </div>
          ) : null}
          {note ? <div className={styles.status}>{note}</div> : null}
        </div>
      ) : note ? <div className={styles.status}>{note}</div> : null}
      <div className={cn(markdown.markdown, styles.page)} data-slot="document-editor-page">{children}</div>
      {formatBar}
    </div>
  );
}

/** Class names for the editor engine's nodes (Lexical `theme`): the page's own element styles do the rest. */
export const documentEditorClasses = {
  root: styles.root,
  bold: styles.bold,
  italic: styles.italic,
  blockEmbed: styles.blockEmbed,
} as const;

export interface DocumentBlockEmbedProps {
  /** The embedded block (an answer block in a BlockActionFrame). */
  children: ReactNode;
  /** Selected as one unit in the text (arrow keys, click): an outline. */
  selected?: boolean;
}

/** A block inside the document text: not editable as text, selectable and movable as one unit. */
export function DocumentBlockEmbed({ children, selected = false }: DocumentBlockEmbedProps) {
  return (
    <div className={styles.blockEmbed} contentEditable={false} data-selected={selected ? "true" : undefined} data-slot="document-block-embed">
      {children}
    </div>
  );
}
