import { useCallback, useEffect, useState } from "react";
import { router } from "expo-router";
import type { MobileCopy } from "../../../butler-i18n/src/index.ts";
import { showToast } from "@/ds";
import { explainLocalNetwork, pairAndOpenHome, pairAnyAndOpenHome } from "./connect";
import { codeDigits } from "./pair";
import { parsePairLink, type PairLinkParams } from "./pairLink";
import { butlerOrigin } from "./probe";

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
    const problem = await pairAndOpenHome(origin, typedCode);
    if (!problem) return;
    setConnecting(false);
    if (problem === "invalidCode") setCodeError(copy.problems.invalidCode);
    else {
      setAddressError(copy.problems[problem]);
      if (explainLocalNetwork(problem, origin)) setExplainer(true);
    }
  }, [copy]);
  const { v, a, c, k, t, u } = params;
  useEffect(() => {
    const link = parsePairLink({ v, a, c, k, t, u });
    if (!link) return;
    router.setParams({ v: undefined, a: undefined, c: undefined, k: undefined, t: undefined, u: undefined });
    if (link.kind === "update_app") {
      showToast({ message: copy.pair.updateApp, tone: "warning" });
      return;
    }
    setCode(link.code ?? "");
    if (link.kind === "pair") {
      setAddress(link.origins[0] ?? "");
      setAddressError(undefined);
      setCodeError(undefined);
      setConnecting(true);
      void pairAnyAndOpenHome(link).then(failure => {
        if (!failure) return;
        const { origin, problem } = failure;
        setConnecting(false);
        setAddress(origin);
        if (problem === "invalidCode") setCodeError(copy.problems.invalidCode);
        else {
          setAddressError(copy.problems[problem]);
          if (explainLocalNetwork(problem, origin)) setExplainer(true);
        }
      });
      return;
    }
    setAddress(link.origin ?? "");
    showToast({ message: copy.pair.linkInvalid, tone: "warning" });
  }, [v, a, c, k, t, u, copy]);
  return {
    address, code, addressError, codeError, connecting, explainer,
    setAddress(t: string) { setAddress(t); setAddressError(undefined); },
    setCode(t: string) { setCode(codeDigits(t)); setCodeError(undefined); },
    connect() { void submit(address, code); },
    retry() { setExplainer(false); return submit(address, code); },
    closeExplainer() { setExplainer(false); },
  };
}
