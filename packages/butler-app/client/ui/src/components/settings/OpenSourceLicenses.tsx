import { useEffect, useState } from "react";
import { appCopy } from "@/app/copy.ts";
import {
  Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
  DisclosureRow, Input, ScrollArea, Stack, Typo,
} from "@/butler-ds";

interface Notice { title: string; license: string; text: string; search: string }

export function OpenSourceLicenses() {
  const copy = appCopy.settings.openSourceLicenses;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [notices, setNotices] = useState<Notice[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!open) { setNotices(null); setQuery(""); setExpanded(null); return; }
    if (notices) return;
    const controller = new AbortController();
    setFailed(false);
    // Same-origin build asset: available in both the bundled and remote renderer.
    fetch(new URL("THIRD_PARTY_NOTICES.txt.gz", document.baseURI), { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(String(response.status));
        if (!response.body) throw new Error("Missing notices body");
        return new Response(response.body.pipeThrough(new DecompressionStream("gzip"))).text();
      })
      .then((text) => {
        const entries = text.split(/\n=====(?: COMPONENT =====)?\n/).slice(1).map((section) => {
          const [name, license] = section.split("\n", 2);
          const body = section.slice(name.length + license.length + 2);
          return { title: name, license, text: body, search: `${name}\n${license}\n${body}`.toLowerCase() };
        });
        if (!entries.length) throw new Error("Empty notices");
        if (!controller.signal.aborted) { setNotices(entries); }
      })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [open, notices, attempt]);

  const filtered = notices?.filter((notice) => notice.search.includes(query.toLowerCase()));
  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>{copy.title}</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="lg" layout="scroll-body" closeLabel={copy.close}>
          <DialogHeader>
            <DialogTitle>{copy.title}</DialogTitle>
            <DialogDescription>{copy.description}</DialogDescription>
            <Input aria-label={copy.searchLabel}
              placeholder={copy.searchPlaceholder} value={query} onChange={(event) => setQuery(event.target.value)} />
          </DialogHeader>
          <ScrollArea fill dataTestClass="open-source-licenses">
            <Stack gap="sm">
              {failed ? <Button variant="ghost" onClick={() => setAttempt((value) => value + 1)}>
                {copy.retry}
              </Button> : !notices ? <Typo.Body>{copy.loading}</Typo.Body> : null}
              {filtered?.map((notice) => (
                <DisclosureRow key={notice.title} title={notice.title} meta={notice.license}
                  open={expanded === notice.title} onToggle={() => setExpanded(expanded === notice.title ? null : notice.title)}>
                  <Typo.Code as="pre" wrap="pre">
                    {notice.text}
                  </Typo.Code>
                </DisclosureRow>
              ))}
              {notices && filtered?.length === 0 ? <Typo.Body>{copy.noResults}</Typo.Body> : null}
            </Stack>
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </>
  );
}
