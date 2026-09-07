import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  NavRow,
  Settings,
} from "@/butler-ds";
import styles from "./SidebarInteractions.module.css";

export function SpaceSettingsButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <NavRow
        icon={
          <span className={styles.identityIcon}>
            <Settings size={16} />
          </span>
        }
        label="설정"
        onClick={() => setOpen(true)}
      />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>설정</DialogTitle>
            <DialogDescription>
              사이드바 디자인을 확인하기 위한 목업입니다. 실제 앱 설정 화면은
              제품에 반영할 때 연결하며, 여기서는 설정을 변경하지 않습니다.
            </DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    </>
  );
}
