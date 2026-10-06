import type { ReactNode } from "react";
import { Tooltip } from "../Tooltip";
import { externalHrefLabel, isBareUrlText, nodeText, splitLabelLead } from "./externalHref";
import { FaviconSlot } from "./FaviconSlot";
import styles from "./InlineReference.module.css";

export interface ExternalReferenceProps {
  /** Absolute http(s) URL. Opens in the system browser (new window, no opener, no referrer). */
  href: string;
  /** The link title. Omitted, or the URL itself, shows the domain instead. */
  children?: ReactNode;
  /** Same-origin favicon URL from the app's favicon service; the globe shows until it loads. */
  iconSrc?: string;
}

/** An external URL in running text: favicon slot, title or domain, the full URL in the tooltip. */
export function ExternalReference({ href, children, iconSrc }: ExternalReferenceProps) {
  const text = nodeText(children);
  const [head, tail] = splitLabelLead(isBareUrlText(text, href) ? externalHrefLabel(href, text) : children);
  return (
    <Tooltip label={href} wrap>
      <a
        className={styles.external}
        data-slot="inline-reference"
        data-kind="external"
        href={href}
        rel="noopener noreferrer"
        target="_blank"
      >
        {/* The icon and the label's first character never part at a line end. */}
        <span className={styles.lead}>
          <FaviconSlot src={iconSrc} />
          <span className={styles.label}>{head}</span>
        </span>
        <span className={styles.label}>{tail}</span>
      </a>
    </Tooltip>
  );
}
