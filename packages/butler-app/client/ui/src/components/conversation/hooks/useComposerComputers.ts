import { useEffect, useState } from "react";
import { setComputerConnection } from "@/app/computerEvents";
import { computerConnection, listComputers, type Computer } from "@/components/settings/computersApi";

export function useComposerComputers(show: boolean) {
  const [computers, setComputers] = useState<Computer[]>([]);
  useEffect(() => {
    if (!show) return;
    let current = true;
    void listComputers().then(({ computers }) => {
      if (!current) return;
      setComputers(computers);
      for (const { id } of computers) {
        void computerConnection(id).then(({ state }) => {
          if (current) setComputerConnection(id, state);
        }).catch(() => {});
      }
    }).catch(() => {});
    return () => { current = false; };
  }, [show]);
  return computers;
}
