import { useEffect, useState } from "react";
import { Image } from "react-native";

type Slots = { front: 0 | 1; sources: [string?, string?] };

export function LiveFrame({ uri, box }: {
  uri: string; box: { x: number; y: number; width: number; height: number };
}) {
  const [{ front, sources }, setSlots] = useState<Slots>({ front: 0, sources: [] });

  useEffect(() => {
    setSlots(({ front, sources }) => {
      const next: Slots["sources"] = [...sources];
      next[1 - front] = sources[front] === uri ? undefined : uri;
      return { front, sources: next };
    });
  }, [uri]);

  return ([0, 1] as const).map(index => {
    const source = sources[index];
    return <Image
      key={index + ":" + (source ?? "")}
      source={source ? { uri: source } : undefined}
      resizeMode="contain"
      fadeDuration={0}
      {...{ pointerEvents: "none" as const }}
      style={{
        position: "absolute", left: box.x, top: box.y, width: box.width, height: box.height,
        opacity: front === index ? 1 : 0,
      }}
      onLoad={() => setSlots(current => {
        if (!source || current.sources[index] !== source || current.front === index) return current;
        return { front: index, sources: index === 0 ? [source, undefined] : [undefined, source] };
      })}
    />;
  });
}
