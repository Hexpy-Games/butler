import {
  ButtonContainer,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
  MoreHorizontal,
  NavSectionHeading,
  Plus,
} from "@/butler-ds";
import { useMock } from "@/app/prototypes/sidebar-space/mock-store";

export function SpaceTreeHeading() {
  const view = useMock((s) => s.view);
  const smart = useMock((s) => s.smart);
  const open = useMock((s) => s.open);
  const setDialog = useMock((s) => s.setDialog);
  const toggleSmart = useMock((s) => s.toggleSmart);
  return (
    <NavSectionHeading
      title={
        view === "all" ? "스페이스" : view === "recent" ? "최신" : "진행중"
      }
      actions={
        <ButtonContainer size="icon-sm">
          <IconButton
            label="그룹 만들기"
            onClick={() => setDialog({ type: "group" })}
          >
            <Plus size={16} />
          </IconButton>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton label="스페이스 설정">
                <MoreHorizontal size={16} />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuCheckboxItem
                checked={smart}
                onCheckedChange={toggleSmart}
              >
                스마트 그룹
              </DropdownMenuCheckboxItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => {
                  open("new");
                  useMock.getState().setDraft("오사카 여행을 계획해줘");
                }}
              >
                여행 자동 그룹 예시 입력
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </ButtonContainer>
      }
    />
  );
}
