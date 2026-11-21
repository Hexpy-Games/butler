import type { ShowcaseGuidance } from "../../showcase";
import { CopyButton } from "../CopyButton";
import { QrCode } from "./QrCode";

// #region recipe: Pairing link
function PairingLink() {
  return <QrCode value="butler://pair?v=1&a=http%3A%2F%2F192.168.1.20%3A19765&c=12345678" label="Pairing QR code" />;
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A scannable QR code that stays dark on white in every theme.",
  whenToUse: ["A link or code another device scans with its camera"],
  whenNotToUse: [{ when: "A link people click or copy", use: "CopyButton" }],
  recipes: [{ name: "Pairing link", description: "Let another device scan the pairing link.", render: () => <PairingLink /> }],
  doDont: [
    {
      do: { caption: "Use CopyButton for a link people copy.", render: () => <CopyButton text="https://example.com" label="Copy link" copiedLabel="Copied" /> },
      dont: { caption: "Do not make people scan a link they can copy.", render: () => <QrCode value="https://example.com" label="Link QR code" /> },
    },
  ],
  content: ["Show the same information as text beside it (the code), so people without a camera can still use it."],
  accessibility: ["label names what the code is for; the svg is role=img."],
  tokens: ["--qr-size", "--qr-background", "--qr-module"],
};
