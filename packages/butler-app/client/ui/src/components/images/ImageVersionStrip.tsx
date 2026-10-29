import { appCopy } from "@/app/copy";
import { Box, Clickable, MediaFrame, ScrollArea, Stack } from "@/butler-ds";
import { assetSource, imageAspect, type ImageAsset } from "./imageApi";

export function ImageVersionStrip({ versions, current, disabled, onSelect }: {
  versions: ImageAsset[]; current: string; disabled: boolean; onSelect: (asset: ImageAsset) => void;
}) {
  const c = appCopy.conversation.imageTools;
  return <ScrollArea orientation="x"><Box padding="xs"><Stack align="row" role="group" aria-label={c.versions}>{versions.map((asset, index) =>
    <Stack key={asset.id} basis="xs" shrink={false}><Clickable aria-label={c.version(index + 1)} selected={asset.id === current}
      disabled={disabled} onClick={() => onSelect(asset)} stretch>
      <Stack grow minWidth="0"><MediaFrame src={assetSource(asset, 96)} alt="" aspect={imageAspect(asset.width, asset.height)} fit="contain" /></Stack>
    </Clickable></Stack>)}</Stack></Box></ScrollArea>;
}
