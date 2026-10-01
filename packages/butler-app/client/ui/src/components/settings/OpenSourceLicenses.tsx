import { useEffect, useState } from "react";
import { useAppLocale } from "@/app/copy.ts";
import {
  Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
  DisclosureRow, Input, ScrollArea, Stack, Typo,
} from "@/butler-ds";

interface Notice { title: string; license: string; text: string; search: string }

export function OpenSourceLicenses() {
  const locale = useAppLocale();
  const ko = locale === "ko-KR";
  const title = ko ? "오픈소스 라이선스" : "Open source licenses";
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
        const entries = text.split("\n===== COMPONENT =====\n").slice(1).map((section) => {
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
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>{title}</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="lg" layout="scroll-body" closeLabel={ko ? "닫기" : "Close"}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{ko ? "구성요소별 라이선스 및 고지" : "Licenses and notices by component"}</DialogDescription>
            <Input aria-label={ko ? "구성요소 검색" : "Search components"}
              placeholder={ko ? "검색" : "Search"} value={query} onChange={(event) => setQuery(event.target.value)} />
          </DialogHeader>
          <ScrollArea fill dataTestClass="open-source-licenses">
            <Stack gap="sm">
              {failed ? <Button variant="ghost" onClick={() => setAttempt((value) => value + 1)}>
                {ko ? "다시 시도" : "Retry"}
              </Button> : !notices ? <Typo.Body>{ko ? "불러오는 중" : "Loading"}</Typo.Body> : null}
              {filtered?.map((notice) => (
                <DisclosureRow key={notice.title} title={notice.title} meta={notice.license}
                  open={expanded === notice.title} onToggle={() => setExpanded(expanded === notice.title ? null : notice.title)}>
                  {expanded === notice.title ? <Typo.Code as="pre" wrap="pre">
                    {notice.text}
                  </Typo.Code> : null}
                </DisclosureRow>
              ))}
              {notices && filtered?.length === 0 ? <Typo.Body>{ko ? "검색 결과 없음" : "No results"}</Typo.Body> : null}
            </Stack>
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </>
  );
}
