import { useState } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Button } from "../Button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../DropdownMenu";
import { Brush, Copy, Download, Eraser, Pencil, Trash2 } from "../Icons";
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from "../Popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../Select";
import { BottomSheet, BottomSheetItem } from "./BottomSheet";

export const meta: ShowcaseMeta = {
  title: "BottomSheet",
  category: "Overlay",
  tags: ["overlay", "sheet", "mobile", "menu", "select", "motion"],
  status: "beta",
};

const labels = {
  "en-US": {
    open: "Open", close: "Close", tool: "Tool", brush: "Brush", eraser: "Eraser",
    quality: "Quality", qualities: ["Low", "Medium", "High"], more: "More", edit: "Edit", copy: "Copy", download: "Download",
    remove: "Delete", models: "Model", info: "Size", infoBody: "1536 × 1024 · PNG",
  },
  "ko-KR": {
    open: "열기", close: "닫기", tool: "도구", brush: "브러시", eraser: "지우개",
    quality: "품질", qualities: ["낮음", "보통", "높음"], more: "더 보기", edit: "편집", copy: "복사", download: "다운로드",
    remove: "삭제", models: "모델", info: "크기", infoBody: "1536 × 1024 · PNG",
  },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

/** Direct use: a short choice list. */
function ToolSheet({ context }: { context: ShowcaseRenderContext }) {
  const copy = text(context);
  const [open, setOpen] = useState(false);
  const [tool, setTool] = useState<"brush" | "eraser">("brush");
  return (
    <>
      <Button variant="outline" text={copy.tool} onClick={() => setOpen(true)} />
      <BottomSheet open={open} onOpenChange={setOpen} title={copy.tool} closeLabel={copy.close}>
        <BottomSheetItem icon={<Brush size="md" />} selected={tool === "brush"} onSelect={() => setTool("brush")}>{copy.brush}</BottomSheetItem>
        <BottomSheetItem icon={<Eraser size="md" />} selected={tool === "eraser"} onSelect={() => setTool("eraser")}>{copy.eraser}</BottomSheetItem>
      </BottomSheet>
    </>
  );
}

/** Expandable: rests at half height; drag the grabber up for the full list. */
function LongSheet({ context }: { context: ShowcaseRenderContext }) {
  const copy = text(context);
  const [open, setOpen] = useState(false);
  const names = ["GPT Image 2.5 Sunburst", "GPT Image 2.5 Flare", "GPT Image 2", "Nano Banana 2.1", "Nano Banana Pro", "Nano Banana 2 Lite"];
  const [value, setValue] = useState(names[0]);
  return (
    <>
      <Button variant="outline" text={copy.models} onClick={() => setOpen(true)} />
      <BottomSheet expandable open={open} onOpenChange={setOpen} title={copy.models} closeLabel={copy.close}>
        {[...names, ...names].map((name, index) => (
          <BottomSheetItem key={`${name}-${index}`} selected={index < names.length && name === value} onSelect={() => setValue(name)}>{name}</BottomSheetItem>
        ))}
      </BottomSheet>
    </>
  );
}

/** presentation="sheet": the same DropdownMenu, opened as a sheet. */
function MenuAsSheet({ context }: { context: ShowcaseRenderContext }) {
  const copy = text(context);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button variant="outline" text={copy.more} /></DropdownMenuTrigger>
      <DropdownMenuContent presentation="sheet">
        <DropdownMenuItem><Pencil size="md" />{copy.edit}</DropdownMenuItem>
        <DropdownMenuItem><Copy size="md" />{copy.copy}</DropdownMenuItem>
        <DropdownMenuItem><Download size="md" />{copy.download}</DropdownMenuItem>
        <DropdownMenuItem variant="destructive"><Trash2 size="md" />{copy.remove}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** presentation="auto": a sheet below 768px, an anchored list above. */
function SelectAuto({ context }: { context: ShowcaseRenderContext }) {
  const copy = text(context);
  const [value, setValue] = useState("1");
  return (
    <Select value={value} onValueChange={setValue}>
      <SelectTrigger aria-label={copy.quality}><SelectValue /></SelectTrigger>
      <SelectContent presentation="auto">
        {copy.qualities.map((quality, index) => <SelectItem key={quality} value={String(index)}>{quality}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

function PopoverAsSheet({ context }: { context: ShowcaseRenderContext }) {
  const copy = text(context);
  return (
    <Popover>
      <PopoverTrigger asChild><Button variant="outline" text={copy.info} /></PopoverTrigger>
      <PopoverContent presentation="sheet">
        <PopoverHeader>
          <PopoverTitle>{copy.info}</PopoverTitle>
          <PopoverDescription>{copy.infoBody}</PopoverDescription>
        </PopoverHeader>
      </PopoverContent>
    </Popover>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "Choice list", widths: ["375", "430"], render: (context) => <ToolSheet context={context} /> },
  { name: "Expandable long list", widths: ["375"], render: (context) => <LongSheet context={context} /> },
  { name: "DropdownMenu presentation=\"sheet\"", widths: ["375", "app"], render: (context) => <MenuAsSheet context={context} /> },
  { name: "Select presentation=\"auto\"", widths: ["375", "app"], render: (context) => <SelectAuto context={context} /> },
  { name: "Popover presentation=\"sheet\"", widths: ["375"], render: (context) => <PopoverAsSheet context={context} /> },
];
