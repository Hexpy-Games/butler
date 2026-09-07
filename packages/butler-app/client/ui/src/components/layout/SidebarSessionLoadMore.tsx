import { NavRow, Space } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";

interface SidebarSessionLoadMoreProps {
  remainingCount: number;
  onClick: () => void;
}

/**
 * Keep the paging action in the same navigation-row surface as its sessions.
 * NavRow supplies the shared row height, typography, hover state, and button
 * keyboard semantics without introducing a second sidebar control style.
 */
export function SidebarSessionLoadMore({
  remainingCount,
  onClick,
}: SidebarSessionLoadMoreProps) {
  const label = `${appCopy.common.more} (${remainingCount})`;

  return (
    <NavRow
      ariaLabel={label}
      dataTestClass="sidebar-load-more"
      icon={<Space direction="horizontal" size="lg" style={{ width: "var(--sidebar-icon-size, 17px)" }} />}
      label={label}
      onClick={onClick}
    />
  );
}
