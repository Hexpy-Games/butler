/** electron-winstaller strips dots from prereleases. Keep lexical NuGet order. */
export function windowsPackageVersion(exact) {
  const match = /^(\d+\.\d+\.\d+)(?:-preview\.(0|[1-9]\d{0,9}))?$/u.exec(exact);
  if (!match) throw new Error("Windows packages require a stable or preview.N version");
  return match[2] === undefined ? match[1] : `${match[1]}-preview${match[2].padStart(10, "0")}`;
}
