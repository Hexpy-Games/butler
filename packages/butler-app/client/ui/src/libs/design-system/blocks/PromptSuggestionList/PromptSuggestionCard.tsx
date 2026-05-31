import { Clickable } from "../../components/Clickable";
import { TintedGlass } from "../../components/TintedGlass";
import { Typo } from "../../components/Typo";
import type { PromptSuggestionItem } from "./PromptSuggestionList";
import styles from "./PromptSuggestionList.module.css";

interface PromptSuggestionCardProps {
  index: number;
  suggestion: PromptSuggestionItem;
}

export function PromptSuggestionCard({
  index,
  suggestion,
}: PromptSuggestionCardProps) {
  return (
    <TintedGlass
      className={styles.itemFrame}
      data-test-class="new-chat-suggestion"
      data-disabled={suggestion.disabled ? "true" : undefined}
      padding="none"
      radius="panel"
    >
      <Clickable
        aria-label={suggestion.text}
        className={styles.item}
        disabled={suggestion.disabled}
        onClick={suggestion.onSelect}
        stretch
      >
        <Typo.Caption
          className={styles.itemMeta}
          data-slot="prompt-suggestion-meta"
        >
          {suggestion.meta ?? String(index + 1).padStart(2, "0")}
        </Typo.Caption>
        <span className={styles.itemCopy}>
          <Typo.H5
            as="span"
            className={styles.itemTitle}
            data-slot="prompt-suggestion-title"
          >
            {suggestion.title}
          </Typo.H5>
          <Typo.Body
            as="span"
            className={styles.itemDescription}
            data-slot="prompt-suggestion-description"
          >
            {suggestion.description}
          </Typo.Body>
        </span>
      </Clickable>
    </TintedGlass>
  );
}
