export const APP_RENDERER_SCHEME: "app";
export const APP_RENDERER_HOST: "butler";
export const APP_RENDERER_ORIGIN: "app://butler";
export const APP_RENDERER_ENTRY_URL: "app://butler/index.html";
export const APP_RENDERER_SCHEME_PRIVILEGES: Readonly<{
  scheme: "app";
  privileges: Readonly<{
    standard: true;
    secure: true;
    supportFetchAPI: true;
    corsEnabled: true;
  }>;
}>;

export function selectRendererUrl(input: {
  devUrl?: string | null;
  staticDistRoot?: string | null;
  serverUrl: string;
}): string;

export function findRendererDistRoot(
  candidates: ReadonlyArray<string | null | undefined>,
  fileExists?: (path: string) => boolean,
): string | null;

export function rendererOriginForUrl(url: string): string;

export function isAppRendererDocumentUrl(value: string): boolean;

export function rendererMimeType(filePath: string): string;

export function createAppRendererProtocolHandler(options: {
  distRoot: string;
  noticesFile?: string | null;
  fetchFavicon?: ((path: string) => Promise<Response>) | null;
}): (request: Request) => Promise<Response>;
