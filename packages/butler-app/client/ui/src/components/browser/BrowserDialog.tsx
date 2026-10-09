import { useRef, useState } from "react";
import { appCopy } from "@/app/copy";
import { Button, ButtonContainer, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Stack, Typo } from "@/butler-ds";
import { browserCall, type BrowserTab } from "./browserBridge";

export interface PageDialog {
  id: string; epoch: number; type: "alert" | "confirm" | "prompt" | "beforeunload" | "auth" | "print" | "file";
  message: string; defaultPrompt: string; origin: string; deadline: number; printers?: Array<{ name: string; label: string }>; approvalRequired?: boolean; untrusted: true;
}
export function BrowserDialog({ tab, container, answer }: {
  tab: Pick<BrowserTab, "id" | "agent" | "holder" | "dialog">; container: HTMLElement | null;
  answer?: (input: Record<string, unknown>) => Promise<unknown>;
}) {
  const dialog = tab.dialog;
  const copy = appCopy.browser;
  const [value, setValue] = useState(dialog?.defaultPrompt ?? "");
  const [username, setUsername] = useState("");
  const [files, setFiles] = useState<Array<{ name: string; type: string; data: string }>>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const [printer, setPrinter] = useState("");
  const [password, setPassword] = useState("");
  if (!dialog || !container) return null;
  const agent = dialog.approvalRequired === true;
  const submit = (accept: boolean) => {
    const input = { id: tab.id, dialog: dialog.id, accept, value, username, password, files, printer };
    void (answer ? answer(input) : browserCall("dialog", input));
  };
  let host = "";
  try { host = new URL(dialog.origin).host; } catch { /* An unloaded page has no origin. */ }
  const leave = dialog.type === "beforeunload";
  const auth = dialog.type === "auth";
  return <Dialog open modal={false} onOpenChange={(open) => { if (!open && !agent) submit(false); }}>
    <DialogContent container={container} showCloseButton={!agent} closeLabel={copy.cancel} data-test-class="browser-page-dialog">
      <DialogHeader><DialogTitle>{leave ? copy.leaveTitle : auth ? copy.authNeeded : dialog.type === "print" ? copy.print : dialog.type === "file" ? copy.attach : copy.pageSays}</DialogTitle>
        <DialogDescription>{host}</DialogDescription></DialogHeader>
      <Stack gap="sm"><Typo.Text>{`“${dialog.message}”`}</Typo.Text>
        {dialog.type === "prompt" && !agent && <Input aria-label={copy.pageSays} value={value} onChange={(event) => setValue(event.target.value)} />}
        {auth && <><Input autoComplete="username" aria-label={copy.username} value={username} onChange={(event) => setUsername(event.target.value)} />
          <Input type="password" autoComplete="current-password" aria-label={copy.password} value={password} onChange={(event) => setPassword(event.target.value)} /></>}
        {dialog.type === "file" && !agent && <><Button size="sm" variant="outline" onClick={() => fileInput.current?.click()}>{copy.attach}</Button>
          {files.length > 0 && <Typo.Caption>{files.map(file => file.name).join(", ")}</Typo.Caption>}
          <input hidden ref={fileInput} type="file" aria-label={copy.attach} accept={dialog.message} multiple={dialog.defaultPrompt === "multiple"}
          onChange={(event) => { void Promise.all([...event.target.files ?? []].map(async (file) => {
            const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1] ?? ""); reader.onerror = reject; reader.readAsDataURL(file); });
            return { name: file.name, type: file.type, data };
          })).then(setFiles); }} /></>}
        {dialog.type === "print" && !agent && <Select value={printer} onValueChange={setPrinter} disabled={!dialog.printers?.length}>
          <SelectTrigger aria-label={copy.printer}><SelectValue placeholder={dialog.printers?.length ? copy.printer : copy.noPrinters} /></SelectTrigger>
          <SelectContent>{dialog.printers?.map(item => <SelectItem key={item.name} value={item.name}>{item.label}</SelectItem>)}</SelectContent>
        </Select>}
        {agent && <Typo.Text>{copy.waiting}</Typo.Text>}
      </Stack>
      {!agent && <DialogFooter><ButtonContainer size="sm">
        {dialog.type !== "alert" && <Button size="sm" variant="outline" onClick={() => submit(false)}>{leave ? copy.stay : copy.cancel}</Button>}
        <Button size="sm" disabled={dialog.type === "print" && !printer || dialog.type === "file" && !files.length} title={dialog.type === "print" && !printer ? copy.printer : dialog.type === "file" && !files.length ? copy.attach : undefined} onClick={() => submit(true)}>{leave ? copy.leave : auth ? copy.signIn : copy.ok}</Button>
      </ButtonContainer></DialogFooter>}
    </DialogContent>
  </Dialog>;
}
