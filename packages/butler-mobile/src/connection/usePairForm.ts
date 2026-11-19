import { useCallback, useEffect, useState } from "react";
import { Platform } from "react-native";
import { router } from "expo-router";
import type { MobileCopy } from "../../../butler-i18n/src/index.ts";
import { showToast } from "@/ds";
import { thisDevice } from "./device";
import { isLocalNetworkHost } from "./localNetwork";
import { nativeFetch } from "./nativeFetch";
import { codeDigits, pairDevice } from "./pair";
import { parsePairLink, type PairLinkParams } from "./pairLink";
import { butlerOrigin } from "./probe";
import { pairingStore } from "./store";

// iOS may refuse the first local-network connection while it asks for permission: explain once per app run.
let localNetworkExplained = false;

export function usePairForm(copy: MobileCopy, params: PairLinkParams) {
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const [addressError, setAddressError] = useState<string>();
  const [codeError, setCodeError] = useState<string>();
  const [connecting, setConnecting] = useState(false);
  const [explainer, setExplainer] = useState(false);
  const submit = useCallback(async (typedAddress: string, typedCode: string) => {
    const origin = butlerOrigin(typedAddress);
    const valid = /^\d{8}$/.test(typedCode);
    setAddressError(origin ? undefined : copy.pair.addressInvalid);
    setCodeError(valid ? undefined : copy.pair.codeInvalid);
    if (!origin || !valid) return;
    setConnecting(true);
    const result = await pairDevice({ origin, code: typedCode, device: thisDevice(), fetch: nativeFetch });
    if (result.ok) {
      try {
        await pairingStore.save(result.pairing);
      } catch {
        setConnecting(false);
        setAddressError(copy.problems.failed);
        return;
      }
      router.canGoBack() ? router.back() : router.replace("/home");
      return;
    }
    setConnecting(false);
    if (result.problem === "invalidCode") setCodeError(copy.problems.invalidCode);
    else {
      setAddressError(copy.problems[result.problem]);
      if (result.problem === "unreachable" && Platform.OS === "ios" && !localNetworkExplained && isLocalNetworkHost(origin)) {
        localNetworkExplained = true;
        setExplainer(true);
      }
    }
  }, [copy]);
  const { v, a, c } = params;
  useEffect(() => {
    const link = parsePairLink({ v, a, c });
    if (!link) return;
    router.setParams({ v: undefined, a: undefined, c: undefined });
    if (link.kind === "update_app") {
      showToast({ message: copy.pair.updateApp, tone: "warning" });
      return;
    }
    setAddress(link.origin ?? "");
    setCode(link.code ?? "");
    if (link.kind !== "pair") showToast({ message: copy.pair.linkInvalid, tone: "warning" });
  }, [v, a, c, copy, submit]);
  return {
    address, code, addressError, codeError, connecting, explainer,
    setAddress(t: string) { setAddress(t); setAddressError(undefined); },
    setCode(t: string) { setCode(codeDigits(t)); setCodeError(undefined); },
    connect() { void submit(address, code); },
    retry() { setExplainer(false); return submit(address, code); },
    closeExplainer() { setExplainer(false); },
  };
}
