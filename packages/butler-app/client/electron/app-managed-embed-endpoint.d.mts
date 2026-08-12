export function prepareAppManagedEmbedSocket(input: {
  butlerData: string;
  platform?: string;
  socketRoot?: string;
  uid?: number | null;
}): string;

export function prepareAppManagedEmbedHealthPort(input: {
  butlerData: string;
  gatewayPort?: number | null;
}): number;
