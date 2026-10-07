import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import {
  Box,
  Button,
  ButtonContainer,
  Clock3,
  IconSlot,
  NavRow,
  NavSectionHeading,
  PencilLine,
  Search,
  SidebarNav,
  Stack,
  Typo,
} from "@/butler-ds";
import { useButlerStore } from "@/app/store";
import { useOrganization } from "@/app/space/organization";
import type { SpaceRowData } from "@/app/space/projection";
import { BrowserEntry } from "../browser/BrowserEntry";
import { SpaceRow } from "./SpaceRow";
import { SpaceBrand } from "./SpaceBrand";

/** These entry actions and shortcuts scroll away before the browse tabs stick. */
export function SpaceHeader({ rows }: { rows: Map<string, SpaceRowData> }) {
  useAppLocale();
  const setDialog = useOrganization((s) => s.setDialog);
  const active = useButlerStore((s) => s.activeChatId);
  const favorites = [...rows.values()].filter((r) => r.pinned);
  return (
    <Stack gap="2xl">
      <Stack gap="xs">
        {window.butlerApp && <SpaceBrand />}
        <SidebarNav ariaLabel={appCopy.space.primaryActions}>
          <NavRow
            icon={<PencilLine />}
            label={appCopy.space.newChat}
            active={active === "draft:chat"}
            onClick={() => useButlerStore.getState().openNewChat()}
          />
          <NavRow
            icon={<Search />}
            label={appCopy.space.search}
            onClick={() => useButlerStore.getState().setCommandOpen(true)}
          />
          <NavRow
            icon={<IconSlot size="sidebar" minHeight="line"><Clock3 /></IconSlot>}
            label={appCopy.space.automations}
            onClick={() => useButlerStore.getState().setView({ kind: "automations" })}
          />
          <BrowserEntry />
        </SidebarNav>
      </Stack>
      <Stack gap="sm">
        <NavSectionHeading title={appCopy.space.favorites} />
        <Stack gap="xs">
          {favorites.slice(0, 2).map((row) => (
            <SpaceRow key={row.node.key} rowKey={row.node.key} shortcut />
          ))}
          {!favorites.length && (
            <Box paddingX="sm">
              <Typo.Caption as="p" tone="secondary">{appCopy.space.favoritesHint}</Typo.Caption>
            </Box>
          )}
          {favorites.length > 2 && (
            <ButtonContainer size="sm">
              <Button
                size="sm"
                variant="inline"
                onClick={() => setDialog({ kind: "favorites" })}
              >
                {appCopy.space.allFavorites}</Button>
            </ButtonContainer>
          )}
        </Stack>
      </Stack>
    </Stack>
  );
}
