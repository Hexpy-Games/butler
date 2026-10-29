import { appCopy } from "@/app/copy";
import { Brush, Button, ButtonContainer, Eraser, IconButton, Popover, PopoverContent, PopoverTrigger, Slider, Tooltip, Undo, type MaskTool } from "@/butler-ds";

export function ImageEditorToolbar({ tool, size, strokes, compare, locked, onTool, onSize, onUndo, onCompare }: {
  tool: MaskTool; size: number; strokes: number; compare: boolean; locked: boolean;
  onTool: (tool: MaskTool) => void; onSize: (size: number) => void; onUndo: () => void; onCompare: (held: boolean) => void;
}) {
  const c = appCopy.conversation.imageTools;
  return <ButtonContainer size="sm">
    <IconButton label={c.brush} pressed={tool === "brush"} selected={tool === "brush"} disabled={locked} onClick={() => onTool("brush")}><Brush size="sm" /></IconButton>
    <IconButton label={c.eraser} pressed={tool === "eraser"} selected={tool === "eraser"} disabled={locked} onClick={() => onTool("eraser")}><Eraser size="sm" /></IconButton>
    <Popover><PopoverTrigger asChild><Button size="sm" variant="ghost" disabled={locked}>{c.brushSize}</Button></PopoverTrigger>
      <PopoverContent presentation="auto"><Slider aria-label={c.brushSize} min={4} max={160} step={4} value={size} onValueChange={onSize} /></PopoverContent>
    </Popover>
    <IconButton label={c.undo} disabled={!strokes || locked} onClick={onUndo}><Undo size="sm" /></IconButton>
    <Tooltip label={c.compare}><Button size="sm" variant="ghost" aria-pressed={compare}
      onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); onCompare(true); }}
      onPointerUp={() => onCompare(false)} onPointerCancel={() => onCompare(false)} onBlur={() => onCompare(false)}
      onKeyDown={event => { if (event.key === " " || event.key === "Enter") { event.preventDefault(); onCompare(true); } }}
      onKeyUp={event => { if (event.key === " " || event.key === "Enter") onCompare(false); }}>{c.original}</Button></Tooltip>
  </ButtonContainer>;
}
