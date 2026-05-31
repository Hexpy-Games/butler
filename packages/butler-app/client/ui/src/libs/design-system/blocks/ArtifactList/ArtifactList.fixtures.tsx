import { ArtifactList } from "./ArtifactList";

export function ArtifactListFixture() {
  return (
    <ArtifactList
      items={[
        {
          id: "conversation",
          title: "butler-dedicated-client-conversation.md",
          description: "document / 7.8 KB",
          onOpen: () => undefined,
          actions: [
            { id: "save", label: "Save", href: "#", download: "conversation.md" },
          ],
        },
        {
          id: "plan",
          title: "plan-butler-dedicated-client-functional-completion.md",
          description: "document / 5.2 KB",
          onOpen: () => undefined,
          actions: [
            { id: "save", label: "Save", href: "#", download: "plan.md" },
          ],
        },
      ]}
    />
  );
}
