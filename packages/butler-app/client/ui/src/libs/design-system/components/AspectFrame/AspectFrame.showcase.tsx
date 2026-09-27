import { useEffect, useRef } from "react";
import type { ShowcaseMeta, ShowcaseStory } from "../../showcase";
import { Stack } from "../Stack";
import { AspectFrame } from "./AspectFrame";

export const meta: ShowcaseMeta = {
  title: "AspectFrame",
  category: "Layout",
  tags: ["canvas", "media", "square", "mark"],
  status: "beta",
};

/** A static canvas drawing (the thinking mark animates the same way). */
function Dot() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    canvas.width = 64;
    canvas.height = 64;
    context.fillStyle = getComputedStyle(canvas).color;
    context.beginPath();
    context.arc(32, 32, 24, 0, Math.PI * 2);
    context.fill();
  }, []);
  return <canvas ref={ref} />;
}

export const stories: ShowcaseStory[] = [
  {
    name: "Fixed sizes and fill",
    render: () => (
      <Stack align="row" cross="end" gap="md">
        <AspectFrame size="sm" aria-hidden="true"><Dot /></AspectFrame>
        <AspectFrame size="lg" aria-hidden="true"><Dot /></AspectFrame>
        <AspectFrame size="2xl" aria-hidden="true"><Dot /></AspectFrame>
      </Stack>
    ),
  },
];
