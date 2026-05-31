import { AttachmentList } from "./AttachmentList";

export function AttachmentListFixture() {
  return (
    <AttachmentList
      items={[
        { id: "a", name: "project-notes.md", meta: "4 KB", href: "#" },
        { id: "b", name: "screenshot.png", meta: "142 KB" },
      ]}
      onRemove={() => undefined}
    />
  );
}
