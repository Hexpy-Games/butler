/** A 32×32 gradient PNG for image-tile examples (inline, so the gallery needs no asset file). */
export const sampleImage = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAPElEQVR4nO3QsQ0AIBDDwCCFXZiJiRmLEVx951P6SF7nvp3MrWlG1QNiImQiZCJkImQiZCJkImQiZKKQD9AtAt9VDH+CAAAAAElFTkSuQmCC";

export interface Strings {
  action: string;
  cancel: string;
  sentence: string;
  note: string;
  meta: string;
  error: string;
  message: string;
  send: string;
  stop: string;
  attach: string;
  close: string;
}

export const en: Strings = {
  action: "Allow",
  cancel: "Cancel",
  sentence: "Finish this on your computer",
  note: "Butler needs your approval on the computer",
  meta: "Just now",
  error: "Check the address",
  message: "Message",
  send: "Send",
  stop: "Stop",
  attach: "Add",
  close: "Close",
};

export const ko: Strings = {
  action: "허용",
  cancel: "취소",
  sentence: "컴퓨터에서 마저 하기",
  note: "컴퓨터에서 승인이 필요합니다",
  meta: "방금",
  error: "주소를 확인해 주세요",
  message: "메시지",
  send: "보내기",
  stop: "중지",
  attach: "추가",
  close: "닫기",
};

export const long: Strings & { title: string } = {
  action: "Zulassen",
  cancel: "Abbrechen",
  sentence: "Auf dem Computer abschließen",
  note: "Butler benötigt Ihre Genehmigung am Computer, bevor es weitermachen kann",
  meta: "Gerade eben aktualisiert vom Computer im Arbeitszimmer",
  error: "Bitte die Adresse prüfen",
  message: "Nachricht",
  send: "Senden",
  stop: "Anhalten",
  attach: "Hinzufügen",
  close: "Schließen",
  title: "Datenschutzgrundverordnungskonforme Rechnungsübersicht für das dritte Quartal exportieren",
};

export const markdown = [
  "# Heading one", "## Heading two", "### Heading three",
  "A paragraph with **strong**, *emphasis*, `code`, ~~deleted~~, [a link](https://example.com), and ![image alt](https://example.com/image.png).",
  "A hard break  \ncontinues with an escaped \\*asterisk.",
  "- An item\n  - A nested item\n\n1. First\n2. Second",
  "```ts\nconst message = 'A code line long enough to scroll horizontally across a narrow conversation screen.';\n```",
  "> A quoted paragraph", "---",
  "| Header | Value |\n| --- | --- |\n| Cell | **Bold cell** |",
].join("\n\n");

export const workActivityCollapsed = {
  status: "Working · 1/2", latest: "Reading the sources", previous: "Checked the request", hiddenCount: 2,
  live: true, expanded: false, label: "Show work details", detailsLabel: "Work details",
};
export const workActivityExpanded = {
  status: "Completed · 2/2 steps", latest: "Finished the work", hiddenCount: 1, live: false, expanded: true,
  label: "Hide work details", detailsLabel: "Work details",
  blocks: [{ title: "Check the request", description: ["Conception · 09:29:42"] }, { title: "Read the sources", tools: [
    { id: "read", icon: "FileText" as const, title: "Read: notes.txt", summaryLabel: "Lookup", details: "Notes from the source" },
    { id: "search", icon: "Search" as const, title: "Search the sources", summaryLabel: "Lookup" },
  ] }],
};
export const workActivityNormal = {
  title: "Read the source", description: ["Check the information before drafting"],
  tools: [{ id: "source", icon: "FileText" as const, title: "Read: notes.txt", summaryLabel: "Lookup", details: "Source notes" }],
};
