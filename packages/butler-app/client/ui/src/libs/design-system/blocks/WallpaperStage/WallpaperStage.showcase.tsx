import type { ShowcaseMeta, ShowcaseStory } from "../../showcase";
import { Box } from "../../components/Box";
import { Typo } from "../../components/Typo";
import { Stack } from "../../components/Stack";
import { Wallpaper } from "../Wallpaper";
import { WallpaperStage } from "./WallpaperStage";

export const meta: ShowcaseMeta = { title: "WallpaperStage", category: "Shell", tags: ["wallpaper", "layer", "desktop"], status: "stable" };
export const stories: ShowcaseStory[] = [{ name: "Content over wallpaper", render: () =>
  <Stack UNSAFE_style={{ width: 360, height: 264 }}>
    <WallpaperStage wallpaper={<Wallpaper source={{ kind: "none" }} motion="paused" />}>
      <Box surface="raised-opaque" elevation="card" border="hairline" radius="panel" padding="lg"><Typo.Body>Content over a Wallpaper</Typo.Body></Box>
    </WallpaperStage>
  </Stack> }];
