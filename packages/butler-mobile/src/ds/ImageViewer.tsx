import { useEffect, useImperativeHandle, useMemo, useRef, useState, type ComponentRef, type Ref } from "react";
import { Animated, Image, Modal, PanResponder, Platform, Pressable, ScrollView, StyleSheet, useWindowDimensions, View, type GestureResponderEvent } from "react-native";
import { BlurView } from "expo-blur";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ViewerImage } from "../conversation/imageViewer";
import { centringInsets, clampView, DOUBLE_TAP_ZOOM, MAX_ZOOM, MIN_ZOOM, onPicture, zoomAt, ZOOM_STEP, type ZoomView } from "../conversation/imageOutputs";
import { PILL } from "../design/tokens";
import { useTokens } from "../design/useTokens";
import { IconButton } from "./Button";
import { icons } from "./icons";
import { TILE_RADIUS } from "./AttachmentTiles";
import { Icon } from "./Icon";
import { Text } from "./Text";
import { GlassFill, GLASS_BLUR_IOS } from "./internal/GlassFill";
import { run, useReducedMotion } from "./internal/motion";

export interface ImageViewerProps {
  images: ViewerImage[]; index: number | null; onIndexChange: (index: number) => void; onClose: () => void;
  labels: { zoomIn: string; zoomOut: string; close: string; previous: string; next: string;
    position: (current: number, total: number) => string; failed: string };
}

export function ImageViewer({ images, index, onIndexChange, onClose, labels }: ImageViewerProps) {
  const t = useTokens();
  const insets = useSafeAreaInsets();
  const open = index !== null;
  const [mounted, setMounted] = useState(open);
  const [scale, setScale] = useState(MIN_ZOOM);
  const zoom = useRef<ImageViewerZoom>(null);
  const retained = useRef(index ?? 0);
  if (index !== null) retained.current = index;
  const current = retained.current;
  const opacity = useRef(new Animated.Value(0)).current;
  const dragFade = useRef(new Animated.Value(1)).current;
  useEffect(() => { if (open) setMounted(true); }, [open]);
  useEffect(() => { setScale(MIN_ZOOM); dragFade.setValue(1); }, [index, dragFade]);
  useEffect(() => {
    if (!mounted) return;
    const animation = run(t, opacity, open ? 1 : 0, open ? "--motion-base" : "--motion-exit-fast",
      open ? "--motion-ease-standard" : "--motion-ease-accelerate");
    animation.start(({ finished }) => { if (finished && !open) setMounted(false); });
    return () => animation.stop();
  }, [mounted, open, t, opacity]);
  return <Modal transparent animationType="none" statusBarTranslucent visible={mounted} onRequestClose={onClose}>
    {mounted ? <View accessibilityViewIsModal onAccessibilityEscape={onClose} style={{ flex: 1 }}>
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: Animated.multiply(opacity, dragFade) }]}>
        <Pressable style={StyleSheet.absoluteFill} accessibilityRole="button" accessibilityLabel={labels.close} onPress={onClose}>
          {Platform.OS === "ios" ? <BlurView style={StyleSheet.absoluteFill} intensity={GLASS_BLUR_IOS}
            tint={t.scheme === "dark" ? "systemUltraThinMaterialDark" : "systemUltraThinMaterialLight"} /> : null}
          <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: t.color("--image-viewer-overlay-bg") }]} />
        </Pressable>
      </Animated.View>
      <Animated.View pointerEvents="box-none" style={{ flex: 1, opacity, paddingTop: insets.top + t.length("--space-3"),
        paddingHorizontal: t.length("--space-3"), paddingBottom: insets.bottom + t.length("--space-3"), gap: t.length("--space-3") }}>
        <View pointerEvents="box-none" style={{ flexDirection: "row", justifyContent: "space-between" }}>
          {images.length > 1 ? <ViewerCapsule><Text variant="caption" numeric="tabular">{labels.position(current + 1, images.length)}</Text></ViewerCapsule> : <View />}
          <ViewerCapsule>
            <IconButton icon={icons.ZoomOut} label={labels.zoomOut} size="sm" variant="ghost" disabled={scale <= MIN_ZOOM} onPress={() => zoom.current?.zoomBy(1 / ZOOM_STEP)} />
            <IconButton icon={icons.ZoomIn} label={labels.zoomIn} size="sm" variant="ghost" disabled={scale >= MAX_ZOOM} onPress={() => zoom.current?.zoomBy(ZOOM_STEP)} />
          </ViewerCapsule>
        </View>
        <ImageViewerStage key={current} ref={zoom} image={images[current]} onScale={setScale} onClose={onClose} dragFade={dragFade}
          label={images[current].alt + (images.length > 1 ? ` · ${labels.position(current + 1, images.length)}` : "")} failedLabel={labels.failed}>
          {images.length > 1 ? <View pointerEvents="box-none" style={[StyleSheet.absoluteFill, { flexDirection: "row", alignItems: "center", justifyContent: "space-between" }]}>
            <ViewerCapsule><IconButton icon={icons.ArrowLeft} label={labels.previous} size="md" variant="ghost" disabled={current === 0} onPress={() => onIndexChange(current - 1)} /></ViewerCapsule>
            <ViewerCapsule><IconButton icon={icons.ChevronRight} label={labels.next} size="md" variant="ghost" disabled={current === images.length - 1} onPress={() => onIndexChange(current + 1)} /></ViewerCapsule>
          </View> : null}
        </ImageViewerStage>
      </Animated.View>
    </View> : null}
  </Modal>;
}

function ViewerCapsule({ children }: { children: React.ReactNode }) {
  const t = useTokens();
  const radius = t.length(PILL);
  return <View style={{ flexDirection: "row", alignItems: "center", minHeight: 36, paddingHorizontal: t.length("--space-2"), borderRadius: radius }}>
    <GlassFill radii={{ topLeft: radius, topRight: radius, bottomRight: radius, bottomLeft: radius }} />
    {children}
  </View>;
}

interface ImageViewerZoom { zoomBy(factor: number): void }
type ZoomProps = {
  width: number; height: number; onScale: (scale: number) => void; onClose: () => void;
  children: React.ReactNode; ref: Ref<ImageViewerZoom>;
};

function ImageViewerStage({ image, label, failedLabel, children, ref, onScale, onClose, dragFade }: {
  image: ViewerImage; label: string; failedLabel: string; children: React.ReactNode; ref: Ref<ImageViewerZoom>;
  onScale: (scale: number) => void; onClose: () => void; dragFade: Animated.Value;
}) {
  const t = useTokens();
  const reduced = useReducedMotion();
  const window = useWindowDimensions();
  const [stage, setStage] = useState({ width: window.width, height: window.height });
  const [failed, setFailed] = useState(false);
  const enter = useRef(new Animated.Value(0)).current;
  const fitted = Math.min(stage.width / image.width, stage.height / image.height, 1);
  const width = image.width * fitted, height = image.height * fitted;
  useEffect(() => {
    enter.setValue(0);
    const animation = run(t, enter, 1, "--motion-base", "--motion-ease-standard");
    animation.start();
    return () => animation.stop();
  }, [t, enter]);
  const picture = <Animated.View style={{ width, height, opacity: enter,
    transform: reduced ? undefined : [{ scale: enter.interpolate({ inputRange: [0, 1], outputRange: [t.number("--motion-scale-dialog"), 1] }) }] }}>
    <Image source={image.source} accessible accessibilityRole="image" accessibilityLabel={label} resizeMode="contain"
      style={{ width, height, borderRadius: TILE_RADIUS, boxShadow: t.shadow("--shadow-card") }} onError={() => setFailed(true)} />
  </Animated.View>;
  return <View pointerEvents="box-none" onLayout={({ nativeEvent }) => setStage(nativeEvent.layout)}
    style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
    {failed ? <ViewerFailure label={failedLabel} /> : Platform.OS === "ios"
      ? <IOSPicture ref={ref} width={width} height={height} stage={stage} onScale={onScale} onClose={onClose}>{picture}</IOSPicture>
      : <AndroidPicture ref={ref} width={width} height={height} onScale={onScale} onClose={onClose} dragFade={dragFade}>{picture}</AndroidPicture>}
    {children}
  </View>;
}

function ViewerFailure({ label }: { label: string }) {
  const t = useTokens();
  return <View style={{ borderRadius: TILE_RADIUS, padding: t.length("--space-md"), gap: t.length("--space-2"), alignItems: "center" }}>
    <GlassFill radii={{ topLeft: TILE_RADIUS, topRight: TILE_RADIUS, bottomRight: TILE_RADIUS, bottomLeft: TILE_RADIUS }} />
    <Icon glyph={icons.Image} size="xl" tone="secondary" />
    <Text variant="caption" tone="secondary">{label}</Text>
  </View>;
}

function IOSPicture({ width, height, stage, children, ref, onScale, onClose }: ZoomProps & { stage: { width: number; height: number } }) {
  const reduced = useReducedMotion();
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const lastPress = useRef(0);
  const [scale, setZoomScale] = useState(MIN_ZOOM);
  const insets = centringInsets(stage, width, height, scale);
  const fit = useMemo(() => centringInsets(stage, width, height, MIN_ZOOM), [stage.width, stage.height, width, height]);
  const restOffset = useMemo(() => ({ x: -fit.left, y: -fit.top }), [fit]);
  const position = useRef({ scale: MIN_ZOOM, x: -fit.left, y: -fit.top });
  const frame = useRef({ x: 0, y: 0 });
  const tap = useRef({ x: 0, y: 0, at: 0, multi: false, dragged: false });
  const zoomTo = (next: number, centreX: number, centreY: number) => {
    const w = stage.width / next, h = stage.height / next;
    scroll.current?.getScrollResponder()?.scrollResponderZoomTo({
      x: centreX - w / 2, y: centreY - h / 2, width: w, height: h, animated: !reduced,
    });
  };
  useImperativeHandle(ref, () => ({ zoomBy(factor) {
    const { scale, x, y } = position.current;
    const cx = Math.max(0, Math.min(width, (x + stage.width / 2) / scale));
    const cy = Math.max(0, Math.min(height, (y + stage.height / 2) / scale));
    zoomTo(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, scale * factor)), cx, cy);
  } }));
  const press = ({ nativeEvent }: GestureResponderEvent) => {
    const now = Date.now();
    if (now - lastPress.current < 300) {
      if (position.current.scale === MIN_ZOOM) zoomTo(DOUBLE_TAP_ZOOM, nativeEvent.locationX, nativeEvent.locationY);
      else zoomTo(MIN_ZOOM, width / 2, height / 2);
      lastPress.current = 0;
    } else lastPress.current = now;
  };
  return <ScrollView ref={scroll} style={{ flex: 1, alignSelf: "stretch" }} contentContainerStyle={{ width, height }}
    contentInset={insets} contentOffset={restOffset}
    automaticallyAdjustContentInsets={false} contentInsetAdjustmentBehavior="never"
    minimumZoomScale={MIN_ZOOM} maximumZoomScale={MAX_ZOOM}
    bouncesZoom alwaysBounceVertical showsHorizontalScrollIndicator={false} showsVerticalScrollIndicator={false}
    onLayout={() => scroll.current?.measureInWindow((x, y) => { frame.current = { x, y }; })}
    onTouchStart={({ nativeEvent }) => {
      tap.current = { x: nativeEvent.pageX, y: nativeEvent.pageY, at: Date.now(), multi: nativeEvent.touches.length > 1, dragged: false };
    }} onTouchMove={({ nativeEvent }) => {
      if (nativeEvent.touches.length > 1) tap.current.multi = true;
    }} onScrollBeginDrag={() => { tap.current.dragged = true; }}
    onTouchEnd={({ nativeEvent }) => {
      const { x, y, at, multi, dragged } = tap.current;
      const { pageX, pageY } = nativeEvent;
      const isTap = !multi && !dragged && Date.now() - at < 300 && Math.hypot(pageX - x, pageY - y) < 10;
      if (isTap && !onPicture({ x: pageX - frame.current.x, y: pageY - frame.current.y }, position.current, width, height, scale)) onClose();
    }}
    scrollEventThrottle={16} onScroll={({ nativeEvent }) => {
      position.current = { scale: nativeEvent.zoomScale!, x: nativeEvent.contentOffset.x, y: nativeEvent.contentOffset.y };
      onScale(nativeEvent.zoomScale!);
      setZoomScale(Math.round(nativeEvent.zoomScale! * 100) / 100);
    }} onScrollEndDrag={({ nativeEvent }) => {
      if (nativeEvent.zoomScale === MIN_ZOOM && nativeEvent.contentOffset.y + insets.top <= -(stage.height / 6)) onClose();
    }}>
    <Pressable accessible={false} onPress={press}>{children}</Pressable>
  </ScrollView>;
}

function AndroidPicture({ width, height, children, ref, onScale, onClose, dragFade }: ZoomProps & { dragFade: Animated.Value }) {
  const t = useTokens();
  const reduced = useReducedMotion();
  const { height: screenHeight } = useWindowDimensions();
  const box = useRef<ComponentRef<typeof View>>(null);
  const view = useRef<ZoomView>({ scale: MIN_ZOOM, x: 0, y: 0 });
  const scale = useRef(new Animated.Value(MIN_ZOOM)).current;
  const x = useRef(new Animated.Value(0)).current;
  const y = useRef(new Animated.Value(0)).current;
  const apply = (next: ZoomView, animate = false) => {
    const clamped = clampView(next, width, height);
    view.current = clamped;
    dragFade.setValue(1);
    onScale(clamped.scale);
    for (const [value, target] of [[scale, clamped.scale], [x, clamped.x], [y, clamped.y]] as const) {
      if (animate && !reduced) run(t, value, target, "--motion-fast", "--motion-ease-standard").start();
      else value.setValue(target);
    }
  };
  const restore = () => {
    if (reduced) { y.setValue(0); dragFade.setValue(1); }
    else Animated.parallel([run(t, y, 0, "--motion-fast", "--motion-ease-standard"),
      run(t, dragFade, 1, "--motion-fast", "--motion-ease-standard")]).start();
  };
  useImperativeHandle(ref, () => ({ zoomBy(factor) {
    apply(zoomAt(view.current, Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, view.current.scale * factor)), 0, 0), true);
  } }));
  const live = useRef({ width, height, screenHeight, apply, restore, onClose });
  live.current = { width, height, screenHeight, apply, restore, onClose };
  const gesture = useRef({ start: view.current, distance: 0, touches: 0, lastPress: 0, originX: 0, originY: 0, pinched: false });
  const responder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onPanResponderGrant: () => {
      const g = gesture.current;
      g.start = view.current;
      g.touches = 0;
      g.pinched = false;
      box.current?.measureInWindow((left, top) => { g.originX = left; g.originY = top; });
    },
    onPanResponderMove: (event, movement) => {
      const touches = event.nativeEvent.touches, g = gesture.current, current = live.current;
      if (touches.length === 2) {
        const [a, b] = touches;
        const distance = Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);
        if (g.touches !== 2) { g.distance = distance; g.start = view.current; g.pinched = true; }
        const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, g.start.scale * distance / g.distance));
        current.apply(zoomAt(view.current, next, (a.pageX + b.pageX) / 2 - g.originX - current.width / 2,
          (a.pageY + b.pageY) / 2 - g.originY - current.height / 2));
      } else if (view.current.scale > MIN_ZOOM) {
        if (g.touches === 2) g.start = { ...view.current, x: view.current.x - movement.dx, y: view.current.y - movement.dy };
        current.apply({ ...view.current, x: g.start.x + movement.dx, y: g.start.y + movement.dy });
      } else {
        y.setValue(Math.max(0, movement.dy));
        dragFade.setValue(Math.max(0, 1 - Math.max(0, movement.dy) / current.screenHeight));
      }
      g.touches = touches.length;
    },
    onPanResponderRelease: (event, movement) => {
      const g = gesture.current, current = live.current;
      if (!g.pinched && view.current.scale === MIN_ZOOM && (movement.dy > current.height / 6 || movement.vy > 0.5)) { current.onClose(); return; }
      if (!g.pinched && Math.hypot(movement.dx, movement.dy) < 10) {
        const now = Date.now();
        if (now - g.lastPress < 300) {
          current.apply(view.current.scale > MIN_ZOOM ? { scale: MIN_ZOOM, x: 0, y: 0 }
            : zoomAt(view.current, DOUBLE_TAP_ZOOM, event.nativeEvent.pageX - g.originX - current.width / 2,
              event.nativeEvent.pageY - g.originY - current.height / 2), true);
          g.lastPress = 0;
        } else g.lastPress = now;
      }
      if (view.current.scale === MIN_ZOOM) current.restore();
    },
    onPanResponderTerminate: () => { if (view.current.scale === MIN_ZOOM) live.current.restore(); },
  }), [view, y, dragFade]);
  return <View pointerEvents="box-none" {...responder.panHandlers} style={{ flex: 1, width: "100%", justifyContent: "center", alignItems: "center", overflow: "hidden" }}>
    <View ref={box} pointerEvents="box-none" style={{ width, height }}>
      <Animated.View style={{ transform: [{ translateX: x }, { translateY: y }, { scale }] }}>{children}</Animated.View>
    </View>
  </View>;
}
