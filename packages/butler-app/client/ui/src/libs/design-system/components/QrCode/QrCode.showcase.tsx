import type { ShowcaseMeta, ShowcaseStory } from "../../showcase";
import { QrCode } from "./QrCode";

export const meta: ShowcaseMeta = {
  title: "QrCode",
  category: "Data display",
  tags: ["qr", "scan", "pairing", "link"],
  status: "beta",
};

export const stories: ShowcaseStory[] = [
  {
    name: "Pairing link",
    render: () => <QrCode value="butler://pair?v=1&a=http%3A%2F%2F192.168.1.20%3A19765&c=12345678" label="Pairing QR code" />,
  },
];
