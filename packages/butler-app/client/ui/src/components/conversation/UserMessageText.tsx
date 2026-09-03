import { useId, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import styles from "./UserMessageText.module.css";

const COLLAPSED_LINES = 5;

export function UserMessageText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const textRef = useRef<HTMLDivElement>(null);
  const id = useId();

  useLayoutEffect(() => {
    const element = textRef.current;
    if (!element) return;
    const measure = () => {
      const lineHeight = Number.parseFloat(window.getComputedStyle(element).lineHeight);
      setOverflowing(element.scrollHeight > lineHeight * COLLAPSED_LINES + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text]);

  return (
    <>
      <div
        id={id}
        ref={textRef}
        className={expanded ? styles.text : styles.collapsed}
        data-test-class="user-message-text"
      >
        {text}
      </div>
      {overflowing && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-controls={id}
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? appCopy.conversation.messageActions.showLess : appCopy.conversation.messageActions.showMore}
        </Button>
      )}
    </>
  );
}
