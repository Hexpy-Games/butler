import {
  Button,
  ButtonContainer,
  NavRow,
  Notebook,
  Stack,
  Typo,
} from "@/butler-ds";
import { useMock } from "@/app/prototypes/sidebar-space/mock-store";
import { isProjectConversation } from "@/app/prototypes/sidebar-space/sample-data";

export function SpaceProjectPreview({ id }: { id: string }) {
  const items = useMock((s) => s.items);
  const open = useMock((s) => s.open);
  const newChat = useMock((s) => s.newProjectChat);
  const project = items.find((item) => item.id === id)!;
  const sessions = items.filter((item) => {
    if (item.kind !== "session" || !isProjectConversation(item, items))
      return false;
    let parent = item.parent;
    while (parent) {
      if (parent === id) return true;
      parent = items.find((row) => row.id === parent)?.parent ?? null;
    }
    return false;
  });
  return (
    <Stack gap="4">
      <Typo.PanelTitle>{project.title}</Typo.PanelTitle>
      <Typo.Body>
        프로젝트 대시보드 미리보기입니다. 아래 항목은 샘플 대화이며 실제
        원장이나 프로젝트에는 연결하지 않습니다.
      </Typo.Body>
      <ButtonContainer size="sm">
        <Button size="sm" onClick={() => newChat(id)}>
          새 대화
        </Button>
      </ButtonContainer>
      {sessions.map((item) => (
        <NavRow
          key={item.id}
          icon={<Notebook />}
          label={item.title}
          onClick={() => open(item.id)}
        />
      ))}
    </Stack>
  );
}
