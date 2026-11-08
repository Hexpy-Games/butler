import { SpaceSidebar } from "@/components/space/SpaceSidebar";
/** `open` is the shell's actual open state; it falls back to the stored one. */
export function Sidebar({ open }: { open?: boolean }) { return <SpaceSidebar open={open} />; }
