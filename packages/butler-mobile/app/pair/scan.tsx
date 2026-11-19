import { useEffect, useRef, useState } from "react";
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from "expo-camera";
import { Linking, View } from "react-native";
import { router } from "expo-router";
import { Button, ButtonGroup, Sheet, showToast, Spinner, Surface, Text, useTokens } from "@/ds";
import { explainLocalNetwork, pairAnyAndOpenHome } from "@/connection/connect";
import { pairParamsFromUrl, parsePairLink } from "@/connection/pairLink";
import type { Problem } from "@/connection/problems";
import { useMobileCopy } from "@/i18n";

type Scan = { kind: "live" } | { kind: "connecting"; origins: string[]; code: string } | { kind: "failed"; origins: string[]; origin: string; code: string; problem: Problem };

export default function PairScan() {
  const copy = useMobileCopy();
  const t = useTokens();
  const [permission, requestPermission] = useCameraPermissions();
  const [unavailable, setUnavailable] = useState(false);
  const [scan, setScan] = useState<Scan>({ kind: "live" });
  const [explainer, setExplainer] = useState(false);
  const asked = useRef(false);
  const busy = useRef(false); // a scan is being handled: ignore further callbacks (they fire per frame)
  const rejected = useRef<string | null>(null); // last rejected QR text: no repeat toast while it stays in view
  useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain && !asked.current) {
      asked.current = true;
      void requestPermission();
    }
  }, [permission, requestPermission]);
  const connect = async (origins: string[], code: string) => {
    setScan({ kind: "connecting", origins, code });
    const failure = await pairAnyAndOpenHome(origins, code);
    if (!failure) return;
    setScan({ kind: "failed", origins, origin: failure.origin, code, problem: failure.problem });
    if (explainLocalNetwork(failure.problem, failure.origin)) setExplainer(true);
  };
  const onScan = ({ data }: BarcodeScanningResult) => {
    if (busy.current || data === rejected.current) return;
    const params = pairParamsFromUrl(data);
    const link = params ? parsePairLink(params) : null;
    if (link?.kind !== "pair") {
      rejected.current = data;
      showToast({ message: link?.kind === "update_app" ? copy.pair.updateApp : copy.pair.notPairingQr, tone: "warning" });
      return;
    }
    busy.current = true;
    void connect(link.origins, link.code);
  };
  const rescan = () => { busy.current = false; rejected.current = null; setScan({ kind: "live" }); };
  const manual = () => router.replace(scan.kind === "failed"
    ? { pathname: "/pair/manual", params: { v: "1", a: scan.origin, c: scan.code } }
    : "/pair/manual");
  const blocked = unavailable || (permission !== null && !permission.granted && permission.status === "denied");
  return (
    <Surface variant="base" grow edges={["top", "bottom", "left", "right"]} padding="lg">
      <View style={{ flex: 1, gap: t.length("--space-4") }}>
        <Text variant="h1">{copy.pair.scan}</Text>
        {blocked ? <Text tone="secondary">{copy.pair.cameraOff}</Text> : scan.kind === "connecting" ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: t.length("--space-2") }}>
            <Spinner label={copy.pair.connecting} /><Text tone="secondary">{copy.pair.connecting}</Text>
          </View>
        ) : scan.kind === "failed" ? <Text tone="danger">{copy.problems[scan.problem]}</Text> : <Text tone="secondary">{copy.pair.scanHint}</Text>}
        {blocked ? <View style={{ flex: 1 }} /> : (
          <View style={{ flex: 1, overflow: "hidden", borderRadius: t.length("--adaptive-composer-radius"), backgroundColor: t.color("--color-surface-raised-opaque") }}>
            {permission?.granted ? <CameraView style={{ flex: 1 }} facing="back" barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              onBarcodeScanned={scan.kind === "live" ? onScan : undefined} onMountError={() => setUnavailable(true)} testID="pair-camera" /> : null}
          </View>
        )}
        <ButtonGroup>
          {blocked ? <>
            <Button label={copy.pair.manual} onPress={manual} />
            {permission && !permission.granted && !permission.canAskAgain ? <Button variant="secondary" label={copy.pair.openSettings} onPress={() => void Linking.openSettings()} /> : null}
          </> : scan.kind === "failed" ? <>
            <Button label={copy.pair.rescan} onPress={rescan} />
            <Button variant="secondary" label={copy.pair.manual} onPress={manual} />
          </> : <Button variant="secondary" label={copy.pair.manual} onPress={manual} disabled={scan.kind === "connecting"} />}
        </ButtonGroup>
      </View>
      <Sheet open={explainer} onClose={() => setExplainer(false)} title={copy.localNetwork.title}
        description={copy.localNetwork.body} cancelLabel={copy.localNetwork.cancel}
        action={<Button label={copy.localNetwork.retry} onPress={() => {
          setExplainer(false);
          if (scan.kind === "failed") { busy.current = true; void connect(scan.origins, scan.code); }
        }} />} />
    </Surface>
  );
}
