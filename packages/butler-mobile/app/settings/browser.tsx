import { useState } from "react";
import { View } from "react-native";
import { getAppCopy } from "../../../butler-i18n/src/index.ts";
import { useConversation } from "@/conversation/live";
import { ListGroup, Button, ListRow, Sheet, showToast, useTokens } from "@/ds";
import { useAppLocale, useMobileCopy } from "@/i18n";
import { SettingsScreen } from "@/settings/layout";
import { SwitchRow, usePicked } from "@/settings/rows";

export default function BrowserSettings() {
  const S = getAppCopy(useAppLocale()).settings, M = useMobileCopy();
  return <SettingsScreen title={S.sections.browser}>
    <HistoryGroup cancelLabel={M.settings.cancel} />
  </SettingsScreen>;
}

function HistoryGroup({ cancelLabel }: { cancelLabel: string }) {
  const app = getAppCopy(useAppLocale()), history = app.browser.history;
  const t = useTokens(), picked = usePicked();
  const { client } = useConversation();
  const [open, setOpen] = useState(false), [range, setRange] = useState("hour"), [butlerOnly, setOnly] = useState(false), [busy, setBusy] = useState(false);
  const clear = async () => {
    if (!client || busy) return;
    setBusy(true);
    try { await client.request("/browser-history/clear", { method: "POST", body: { range, butlerOnly } }); setOpen(false); }
    catch { showToast({ message: app.browser.failed, tone: "error" }); }
    finally { setBusy(false); }
  };
  return <ListGroup>
    <ListRow title={history.clear} destructive onPress={() => { setRange("hour"); setOnly(false); setOpen(true); }} />
    <Sheet open={open} onClose={() => { if (!busy) setOpen(false); }} title={history.clear} cancelLabel={cancelLabel}
      action={<Button variant="destructive" label={app.browser.remove} loading={busy} onPress={() => void clear()} />}>
      <View style={{ gap: t.length("--space-4") }}>
        <ListGroup>
          {(["hour", "today", "week", "all"] as const).map(value => <ListRow key={value} title={history[value]} disabled={busy}
            {...picked(range === value, [history[value]])} onPress={() => setRange(value)} />)}
        </ListGroup>
        <ListGroup><SwitchRow title={history.butlerOnly} value={butlerOnly} disabled={busy} onChange={setOnly} /></ListGroup>
      </View>
    </Sheet>
  </ListGroup>;
}
