import { useState } from "react";
import { useAppLocale } from "@/app/copy";
import { useMinuteClock } from "@/app/space/minute-clock";
import { butlerBackupSection } from "./ButlerBackupSection";
import { useButlerBackup } from "./hooks/useButlerBackup";
import { butlerAccountSections } from "./ButlerAccountSection";
import { useButlerAccount } from "./hooks/useButlerAccount";
import { usePublishedPages } from "./hooks/usePublishedPages";
import { publishedPagesSection } from "./PublishedPagesSection";
import { SettingsPage } from "./SettingsFormComponents";

export function AccountSettings() {
  useAppLocale();
  const account = useButlerAccount();
  const backup = useButlerBackup(account.status?.signed_in ? account.status.account.id : undefined);
  const [signInOpen, setSignInOpen] = useState(false);
  const published = usePublishedPages();
  const now = useMinuteClock(account.devices.length > 0);
  return (
    <SettingsPage>
      {butlerAccountSections({ account, signInOpen, setSignInOpen, now })}
      {butlerBackupSection({ backup, account })}
      {publishedPagesSection(published)}
    </SettingsPage>
  );
}
