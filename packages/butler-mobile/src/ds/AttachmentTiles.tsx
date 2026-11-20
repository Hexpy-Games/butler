import { useEffect, useRef } from "react";
import { Animated, Image, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { PILL } from "../design/tokens";
import { useTokens } from "../design/useTokens";
import { Icon } from "./Icon";
import { icons } from "./icons";
import { GlassFill } from "./internal/GlassFill";
import { run, useReducedMotion } from "./internal/motion";
import { Spinner } from "./Spinner";
import { Text } from "./Text";

export interface AttachmentTile {
  key: string;
  name: string;
  kind: "image" | "file";
  /** Image source (uri + optional headers) for kind "image". */
  image?: { uri: string; headers?: Record<string, string> };
  /** Upper-case extension ("PDF") or the localized "File". */
  extension: string;
  /** Formatted size, shown only in the "wrap" layout. */
  meta?: string;
  upload?: "uploading" | "failed";
}

export interface AttachmentTilesProps {
  items: AttachmentTile[];
  layout: "row" | "wrap";
  onRemove?: (key: string) => void;
  removeLabel?: (name: string) => string;
  uploadingLabel: string;
  failedLabel: string;
}

// concentric with the composer: RADIUS (28) minus the composer's inner padding (12)
const TILE_RADIUS = 16;

function Tile({ item, layout, onRemove, removeLabel, uploadingLabel, failedLabel }: Omit<AttachmentTilesProps, "items"> & { item: AttachmentTile }) {
  const t = useTokens();
  const reduced = useReducedMotion();
  const enter = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  useEffect(() => {
    if (reduced) { enter.setValue(1); return; }
    const animation = run(t, enter, 1, "--motion-base", "--motion-ease-standard");
    animation.start();
    return () => animation.stop();
  }, [t, enter, reduced]);
  const size = layout === "row" ? 64 : 96;
  const uploading = item.upload === "uploading";
  const failed = item.upload === "failed";
  const pill = t.length(PILL);
  const radii = { topLeft: pill, topRight: pill, bottomRight: pill, bottomLeft: pill };
  const label = [item.name, item.upload ? (uploading ? uploadingLabel : failedLabel) : undefined].filter(Boolean).join(", ");
  return <Animated.View style={{ width: size, height: size, opacity: enter,
    transform: [{ scale: enter.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1] }) }] }}>
    <View accessible accessibilityLabel={label} accessibilityState={{ busy: uploading }}
      style={{ width: "100%", height: "100%", borderRadius: TILE_RADIUS, overflow: "hidden",
        borderWidth: t.length("--border-hairline"), borderColor: t.color(failed ? "--danger" : "--color-border-strong"),
        backgroundColor: t.color("--color-surface-raised-opaque") }}>
      {item.kind === "image" && item.image ? <>
        <Image source={{ uri: item.image.uri, headers: item.image.headers }} resizeMode="cover"
          style={{ ...StyleSheet.absoluteFill, opacity: uploading ? 0.45 : 1 }} />
        {uploading ? <View style={{ ...StyleSheet.absoluteFill, alignItems: "center", justifyContent: "center" }}>
          <View style={{ width: 32, height: 32, borderRadius: pill, alignItems: "center", justifyContent: "center" }}>
            <GlassFill radii={radii} /><Spinner size={14} />
          </View>
        </View> : null}
      </> : <View style={{ flex: 1, padding: layout === "row" ? 6 : t.length("--space-2"), gap: t.length("--space-1") }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: t.length("--space-1") }}>
          {uploading ? <Spinner size={14} /> : <Icon glyph={failed ? icons.AlertCircle : icons.File} size="xs" tone={failed ? "danger" : "tertiary"} />}
          <View style={{ flex: 1 }}><Text variant="caption" weight="semibold" tone={failed ? "danger" : "secondary"} lines={1}>{item.extension}</Text></View>
        </View>
        <Text variant="caption" lines={layout === "row" ? 1 : 2}>{item.name}</Text>
        {layout === "wrap" && item.meta ? <View style={{ marginTop: "auto" }}>
          <Text variant="caption" tone="tertiary" numeric="tabular">{item.meta}</Text>
        </View> : null}
      </View>}
    </View>
    {layout === "row" && onRemove ? <Pressable onPress={() => onRemove(item.key)}
      hitSlop={(t.length("--control-hit-target") - 24) / 2} accessibilityRole="button" accessibilityLabel={removeLabel?.(item.name)}
      style={{ position: "absolute", top: t.length("--space-1"), end: t.length("--space-1"),
        width: 24, height: 24, borderRadius: pill, alignItems: "center", justifyContent: "center" }}>
      <GlassFill radii={radii} /><HugeiconsIcon icon={icons.X} size={12} color={t.color("--text-primary")} />
    </Pressable> : null}
  </Animated.View>;
}

export function AttachmentTiles({ items, layout, ...props }: AttachmentTilesProps) {
  const t = useTokens();
  const tiles = items.map(item => <Tile key={item.key} item={item} layout={layout} {...props} />);
  const gap = t.length("--space-2");
  return layout === "row" ? <ScrollView horizontal showsHorizontalScrollIndicator={false}
    contentContainerStyle={{ gap, paddingTop: t.length("--space-3"), paddingHorizontal: t.length("--space-4"), paddingBottom: 0 }}>
    {tiles}
  </ScrollView> : <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap }}>{tiles}</View>;
}
