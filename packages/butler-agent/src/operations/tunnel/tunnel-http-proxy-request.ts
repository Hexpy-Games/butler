import { timingSafeEqual } from "node:crypto";
import {
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { PassThrough } from "node:stream";
import {
  forwardedTunnelRequestHeaders,
  forwardedTunnelResponseHeaders,
  isTunnelRequestAuthorized,
  rejectTunnelUnauthorized,
  rewriteTunnelHtml,
  setTunnelSessionCookie,
  type NormalizedTunnelProxyConfig,
} from "./tunnel-http-proxy-config.ts";

/** The one request-level owner registered in the proxy's active set. */
export interface TunnelProxyRequestHandle {
  terminate: () => void;
}

export interface TunnelProxyRequestInput {
  config: NormalizedTunnelProxyConfig;
  clientRequest: IncomingMessage;
  clientResponse: ServerResponse;
  registerActive: (handle: TunnelProxyRequestHandle) => void;
  unregisterActive: (handle: TunnelProxyRequestHandle) => void;
}

function safeStatus(response: IncomingMessage): number {
  return Number.isInteger(response.statusCode) && (response.statusCode ?? 0) >= 100
    ? response.statusCode as number
    : 502;
}

function requestClient(upstream: URL): typeof httpRequest {
  return upstream.protocol === "https:" ? httpsRequest : httpRequest;
}

function writeUpstreamFailure(response: ServerResponse): void {
  if (response.headersSent) {
    if (!response.writableEnded && !response.destroyed) response.destroy();
    return;
  }
  response.writeHead(502, {
    "cache-control": "no-store",
    "content-type": "text/plain; charset=utf-8",
  });
  response.end("Tunnel upstream unavailable.\n");
}

/**
 * Own one downstream/upstream request pair. The relay server supplies only
 * active-set registration; all request listeners, body buffering, backpressure
 * and terminal teardown stay in this capability module.
 */
export function handleTunnelProxyRequest(
  input: TunnelProxyRequestInput,
): void {
  const {
    config,
    clientRequest,
    clientResponse,
    registerActive,
    unregisterActive,
  } = input;
  const requestUrl = new URL(clientRequest.url ?? "/", config.upstream);
  if (requestUrl.pathname === "/__butler_tunnel_login") {
    const token = requestUrl.searchParams.get("token") ?? "";
    if (!config.auth.loginToken?.trim() ||
      !timingSafeTokenEqual(token, config.auth.loginToken.trim())) {
      clientRequest.resume();
      rejectTunnelUnauthorized(clientResponse);
      return;
    }
    clientRequest.resume();
    clientResponse.writeHead(302, setTunnelSessionCookie({
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
      location: "/",
    }, config.auth));
    clientResponse.end("Logged in. Redirecting.\n");
    return;
  }
  if (!isTunnelRequestAuthorized(clientRequest, config.auth)) {
    clientRequest.resume();
    rejectTunnelUnauthorized(clientResponse);
    return;
  }
  if (requestUrl.pathname === config.bootstrapPath) {
    clientRequest.resume();
    clientResponse.writeHead(200, setTunnelSessionCookie({
      "cache-control": "no-store",
      "content-type": "application/javascript; charset=utf-8",
    }, config.auth));
    clientResponse.end(config.bootstrapScript);
    return;
  }

  // This must be initialized after abort listeners are attached so an
  // already-aborted client can terminate before creating an upstream leg.
  // The request is created after abort listeners are installed.
  // eslint-disable-next-line prefer-const
  let upstreamRequest: ClientRequest | undefined;
  let upstreamResponse: IncomingMessage | undefined;
  let responsePipe: PassThrough | undefined;
  let settled = false;
  let htmlOverflow = false;

  const handle: TunnelProxyRequestHandle = {
    terminate: () => terminate(),
  };
  const destroyLegs = () => {
    if (upstreamResponse && !upstreamResponse.destroyed) upstreamResponse.destroy();
    if (upstreamRequest && !upstreamRequest.destroyed) upstreamRequest.destroy();
    if (responsePipe && !responsePipe.destroyed) responsePipe.destroy();
  };
  const detachSignal = () => {
    config.clientDisconnectSignal?.removeEventListener("abort", terminate);
    detachClientListeners();
  };
  const settle = () => {
    if (settled) return;
    settled = true;
    detachSignal();
    unregisterActive(handle);
  };
  const terminate = () => {
    if (settled) return;
    settled = true;
    destroyLegs();
    detachSignal();
    if (!clientResponse.writableEnded && !clientResponse.destroyed) clientResponse.destroy();
    unregisterActive(handle);
  };
  const onClientRequestAborted = terminate;
  const onClientRequestError = terminate;
  const onClientRequestClose = () => {
    if (!clientRequest.complete) terminate();
  };
  const onClientResponseAborted = terminate;
  const onClientResponseError = terminate;
  const onClientResponseClose = () => {
    if (!clientResponse.writableEnded) terminate();
  };
  const detachClientListeners = () => {
    clientRequest.removeListener("aborted", onClientRequestAborted);
    clientRequest.removeListener("error", onClientRequestError);
    clientRequest.removeListener("close", onClientRequestClose);
    clientResponse.removeListener("aborted", onClientResponseAborted);
    clientResponse.removeListener("error", onClientResponseError);
    clientResponse.removeListener("close", onClientResponseClose);
    clientResponse.removeListener("finish", settle);
  };
  const fail = () => {
    if (settled) return;
    settled = true;
    destroyLegs();
    detachSignal();
    writeUpstreamFailure(clientResponse);
    unregisterActive(handle);
  };
  const rejectHtmlOverflow = () => {
    if (settled || htmlOverflow) return;
    htmlOverflow = true;
    settled = true;
    destroyLegs();
    detachSignal();
    writeUpstreamFailure(clientResponse);
    unregisterActive(handle);
  };

  registerActive(handle);
  clientRequest.once("aborted", onClientRequestAborted);
  clientRequest.once("error", onClientRequestError);
  clientRequest.once("close", onClientRequestClose);
  clientResponse.once("aborted", onClientResponseAborted);
  clientResponse.once("error", onClientResponseError);
  clientResponse.once("close", onClientResponseClose);
  clientResponse.once("finish", settle);
  if (config.clientDisconnectSignal) {
    if (config.clientDisconnectSignal.aborted) {
      terminate();
      return;
    }
    config.clientDisconnectSignal.addEventListener("abort", terminate, { once: true });
  }

  const targetPath = `${requestUrl.pathname}${requestUrl.search}`;
  const makeRequest = requestClient(config.upstream);
  upstreamRequest = makeRequest({
    protocol: config.upstream.protocol,
    hostname: config.upstream.hostname,
    port: config.upstream.port || undefined,
    method: clientRequest.method,
    path: targetPath,
    headers: forwardedTunnelRequestHeaders(
      clientRequest.headers,
      config.upstream,
      config.auth.upstreamBearerToken,
    ),
  }, (response) => {
    upstreamResponse = response;
    response.once("error", fail);
    response.once("aborted", terminate);
    const contentType = String(response.headers["content-type"] ?? "").toLowerCase();
    if (!contentType.includes("text/html")) {
      clientResponse.writeHead(safeStatus(response), setTunnelSessionCookie(
        forwardedTunnelResponseHeaders(response.headers),
        config.auth,
      ));
      responsePipe = new PassThrough({ highWaterMark: config.maxBufferedBytes });
      responsePipe.once("error", fail);
      response.pipe(responsePipe);
      responsePipe.pipe(clientResponse);
      return;
    }

    const declaredLength = Number(response.headers["content-length"] ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > config.maxHtmlBytes) {
      rejectHtmlOverflow();
      return;
    }

    const chunks: Buffer[] = [];
    let byteLength = 0;
    response.on("data", (chunk: Buffer | string) => {
      if (settled || htmlOverflow) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteLength += buffer.byteLength;
      if (byteLength > config.maxHtmlBytes) {
        rejectHtmlOverflow();
        return;
      }
      chunks.push(buffer);
    });
    response.once("end", () => {
      if (settled || htmlOverflow) return;
      const inputHtml = Buffer.concat(chunks).toString("utf8");
      const body = (config.rewriteHtml ?? ((html: string) =>
        rewriteTunnelHtml(html, config.bootstrapPath)))(inputHtml);
      const headers = setTunnelSessionCookie(
        forwardedTunnelResponseHeaders(response.headers),
        config.auth,
      );
      delete headers["content-length"];
      headers["content-length"] = Buffer.byteLength(body);
      clientResponse.writeHead(safeStatus(response), headers);
      clientResponse.end(body);
    });
  });
  upstreamRequest.once("error", fail);
  clientRequest.pipe(upstreamRequest);
}

function timingSafeTokenEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer);
}
