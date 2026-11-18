export interface Strings {
  action: string;
  cancel: string;
  sentence: string;
  note: string;
  meta: string;
  error: string;
  message: string;
  send: string;
  stop: string;
  attach: string;
  close: string;
}

export const en: Strings = {
  action: "Allow",
  cancel: "Cancel",
  sentence: "Finish this on your computer",
  note: "Butler needs your approval on the computer",
  meta: "Just now",
  error: "Check the address",
  message: "Message",
  send: "Send",
  stop: "Stop",
  attach: "Add",
  close: "Close",
};

export const ko: Strings = {
  action: "허용",
  cancel: "취소",
  sentence: "컴퓨터에서 마저 하기",
  note: "컴퓨터에서 승인이 필요합니다",
  meta: "방금",
  error: "주소를 확인해 주세요",
  message: "메시지",
  send: "보내기",
  stop: "중지",
  attach: "추가",
  close: "닫기",
};

export const long: Strings & { title: string } = {
  action: "Zulassen",
  cancel: "Abbrechen",
  sentence: "Auf dem Computer abschließen",
  note: "Butler benötigt Ihre Genehmigung am Computer, bevor es weitermachen kann",
  meta: "Gerade eben aktualisiert vom Computer im Arbeitszimmer",
  error: "Bitte die Adresse prüfen",
  message: "Nachricht",
  send: "Senden",
  stop: "Anhalten",
  attach: "Hinzufügen",
  close: "Schließen",
  title: "Datenschutzgrundverordnungskonforme Rechnungsübersicht für das dritte Quartal exportieren",
};
