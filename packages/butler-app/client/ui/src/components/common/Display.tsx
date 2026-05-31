import React from "react";
import { Circle, Clickable, EmptyLine, FileText, ListRow } from "@/butler-ds";
import type { IconElement, SessionArtifactSummary } from "@/app/types.ts";

export function EmptyPanelLine({ label }: { label: string }) {
  return <EmptyLine icon={<Circle size={15} />} message={label} />;
}

export function Suggestion({
  icon,
  text,
  disabled,
  onClick,
}: {
  icon: IconElement;
  text: string;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <Clickable disabled={disabled} onClick={onClick} aria-label={text}>
      {React.cloneElement(icon, { size: 17 })}
      <span>{text}</span>
    </Clickable>
  );
}

export function Artifact({
  artifact,
  label,
  selected = false,
  onClick,
}: {
  artifact?: Pick<SessionArtifactSummary, "title">;
  label?: string;
  selected?: boolean;
  onClick?: () => void;
}) {
  const title = artifact?.title ?? label ?? "Artifact";
  if (onClick) {
    return (
      <Clickable
        aria-current={selected ? "true" : undefined}
        onClick={onClick}
        aria-label={title}
      >
        <ListRow icon={<FileText size={17} />} title={title} />
      </Clickable>
    );
  }
  return <ListRow icon={<FileText size={17} />} title={title} />;
}
