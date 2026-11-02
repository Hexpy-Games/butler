import { useEffect, useRef } from "react";
import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import { Button } from "@/butler-ds";

/** Section header actions of a skills list: import a zip, create one in a chat. */
export function SkillActions({
  onImport,
  onCreate,
  errorId,
}: {
  /** Set while an import error for this list shows in its card; focuses Import and describes it. */
  errorId?: string;
  onImport: () => void;
  onCreate: () => void;
}) {
  useAppLocale();
  const copy = appCopy.settings.actions;
  const importRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (errorId) importRef.current?.focus(); }, [errorId]);
  return (
    <>
      <Button ref={importRef} aria-invalid={Boolean(errorId)} aria-describedby={errorId} type="button" variant="outline" size="sm" onClick={onImport}>
        {copy.importSkill}
      </Button>
      <Button type="button" variant="outline" size="sm" onClick={onCreate}>
        {copy.createSkillWithChat}
      </Button>
    </>
  );
}
