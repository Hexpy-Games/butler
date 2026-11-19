import { useEffect, useState } from "react";
import { Redirect } from "expo-router";
import { pairingStore } from "@/connection/store";

export default function Index() {
  const [target, setTarget] = useState<"/home" | "/pair">();
  useEffect(() => {
    void pairingStore.loadActive().then(
      pairing => setTarget(pairing ? "/home" : "/pair"),
      () => setTarget("/pair"),
    );
  }, []);
  return target ? <Redirect href={target} /> : null;
}
