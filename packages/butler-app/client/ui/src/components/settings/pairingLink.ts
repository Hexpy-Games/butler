/** The link the Butler phone app scans: up to 4 of this computer's addresses, in the gateway's order, and the code. */
export function pairingLink(addresses: readonly string[], code: string, tunnel?: { publicKey: string; tunnelId: string } | null): string | null {
  if (addresses.length === 0 && !tunnel) return null;
  const params = new URLSearchParams({ v: "1" });
  for (const address of addresses.slice(0, 4)) params.append("a", address);
  if (tunnel) {
    params.append("k", tunnel.publicKey);
    params.append("t", tunnel.tunnelId);
  }
  params.append("c", code);
  return `butler://pair?${params}`;
}
