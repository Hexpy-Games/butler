import { useState } from "react";
import {
  Button,
  ButtonContainer,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  NavSection,
  Stack,
} from "@/butler-ds";
import { useMock } from "@/app/prototypes/sidebar-space/mock-store";
import { SpaceRow } from "./SpaceRow";
import styles from "./SpaceMockup.module.css";

export function SpaceFavorites() {
  const items = useMock((s) => s.items);
  const [expanded, setExpanded] = useState(false);
  const favorites = items.filter((item) => item.pinned);
  return (
    <>
      <NavSection
        title="즐겨찾기"
        actions={
          favorites.length > 2 && (
            <ButtonContainer size="sm">
              <Button
                size="sm"
                variant="inline"
                onClick={() => setExpanded(true)}
              >
                모두 보기 · {favorites.length}
              </Button>
            </ButtonContainer>
          )
        }
      >
        {favorites.slice(0, 2).map((item) => (
          <SpaceRow key={item.id} id={item.id} shortcut />
        ))}
      </NavSection>
      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent className={styles.favoritesDialog}>
          <DialogHeader>
            <DialogTitle>즐겨찾기</DialogTitle>
            <DialogDescription>
              자주 찾는 대화와 프로젝트 {favorites.length}개
            </DialogDescription>
          </DialogHeader>
          <Stack gap="1" className={styles.choices}>
            {favorites.map((item) => (
              <SpaceRow
                key={item.id}
                id={item.id}
                shortcut
                onOpen={() => setExpanded(false)}
              />
            ))}
          </Stack>
        </DialogContent>
      </Dialog>
    </>
  );
}
