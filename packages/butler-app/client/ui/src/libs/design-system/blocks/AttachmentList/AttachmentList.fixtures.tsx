import { AttachmentList } from "./AttachmentList";

const fixtureThumbnailSrc =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Crect width='24' height='24' fill='%23e9eaec'/%3E%3Cpath d='m4 17 4.5-5 3.5 3 2.5-3 5.5 6H4Z' fill='%2371767d'/%3E%3C/svg%3E";

export function AttachmentListFixture() {
  return (
    <div>
      <AttachmentList
        items={[
          {
            id: "a",
            name: "screenshot.png",
            meta: "142 KB",
            thumbnail: {
              alt: "Screenshot preview",
              src: fixtureThumbnailSrc,
            },
          },
          { id: "b", name: "project-notes.md", meta: "4 KB", href: "#" },
        ]}
        onRemove={() => undefined}
      />
      <div
        data-test-class="attachment-list-chip-container"
        style={{ maxWidth: "calc(var(--space-6) * 32)" }}
      >
        <AttachmentList
          items={[
            {
              id: "chip-image",
              name: "a-very-long-image-file-name.png",
              meta: "142 KB",
              thumbnail: {
                alt: "Image preview",
                src: fixtureThumbnailSrc,
              },
            },
            {
              id: "chip-markdown",
              name: "a-very-long-markdown-file-name.md",
              meta: "4 KB",
            },
            { id: "chip-json", name: "large-export.json", meta: "2 MB" },
            { id: "chip-log", name: "runtime-output.log", meta: "84 KB" },
            { id: "chip-text", name: "readme.txt", meta: "12 KB" },
          ]}
          onRemove={() => undefined}
          variant="chips"
        />
      </div>
    </div>
  );
}
