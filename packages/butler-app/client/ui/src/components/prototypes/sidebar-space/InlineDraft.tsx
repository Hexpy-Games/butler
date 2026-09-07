import { useInlineDraft } from "./hooks/useInlineDraft";
import styles from "./InlineDraft.module.css";

export function InlineDraft() {
  const { editor, rememberCaret, sync, insert } = useInlineDraft();
  return (
    <div
      ref={editor}
      className={styles.editor}
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      aria-label="메시지 입력"
      data-placeholder="Butler에게 무엇이든 물어보세요"
      onInput={sync}
      onKeyUp={rememberCaret}
      onMouseUp={rememberCaret}
      onBlur={rememberCaret}
      onPaste={(event) => {
        event.preventDefault();
        insert(
          document.createTextNode(event.clipboardData.getData("text/plain")),
        );
      }}
    />
  );
}
