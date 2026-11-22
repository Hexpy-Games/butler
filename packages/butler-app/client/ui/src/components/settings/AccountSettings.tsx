import { useState } from "react";
import { useAppLocale } from "@/app/copy";
import { useMinuteClock } from "@/app/space/minute-clock";
import { butlerAccountSections } from "./ButlerAccountSection";
import { useButlerAccount } from "./hooks/useButlerAccount";
import { SettingsPage } from "./SettingsFormComponents";

export function AccountSettings() {
  useAppLocale();
  const account = useButlerAccount();
  const [signInOpen, setSignInOpen] = useState(false);
  const now = useMinuteClock(account.devices.length > 0);
  return (
    <SettingsPage>
      {butlerAccountSections({ account, signInOpen, setSignInOpen, now })}
    </SettingsPage>
  );
}
