let open: string | null = null;

export function setOpenChat(id: string) { open = id; }
export function clearOpenChat(id: string) { if (open === id) open = null; }
export function openChat() { return open; }
