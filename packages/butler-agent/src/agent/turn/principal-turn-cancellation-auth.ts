import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { resolve } from "node:path";

const AUTH_WINDOW_MS = 30_000;
const MAX_REPLAY_NONCES = 1_024;

export interface WindowsCancellationControl {
  version: 1;
  generation: string;
  pipe_path: string;
  secret: string;
  raw_text_included: false;
}

interface AuthenticatedRequest<T> {
  version: 2;
  generation: string;
  nonce: string;
  issued_at_ms: number;
  request: T;
  mac: string;
}

interface AuthenticatedResponse<T> {
  version: 2;
  generation: string;
  nonce: string;
  response: T;
  mac: string;
}

export function createWindowsCancellationControl(
  butlerData: string,
  input: {
    generateSecret?: () => Buffer;
    generateGeneration?: () => string;
  } = {},
): WindowsCancellationControl {
  const generation = (input.generateGeneration ?? randomUUID)();
  const rootHash = createHash("sha256")
    .update(resolve(butlerData))
    .digest("hex")
    .slice(0, 24);
  const pipeName = `butler-cancel-${rootHash}-${safeSegment(generation)}`;
  const secret = (input.generateSecret ?? (() => randomBytes(32)))();
  if (secret.length !== 32) throw new Error("invalid Windows cancellation secret");
  return {
    version: 1,
    generation,
    pipe_path: `\\\\.\\pipe\\${pipeName}`,
    secret: secret.toString("base64"),
    raw_text_included: false,
  };
}

export function windowsCancellationPipeName(control: WindowsCancellationControl): string {
  const prefix = "\\\\.\\pipe\\";
  if (!control.pipe_path.startsWith(prefix)) {
    throw new Error("invalid Windows cancellation pipe path");
  }
  const name = control.pipe_path.slice(prefix.length);
  if (!/^[0-9A-Za-z-]{20,160}$/u.test(name)) {
    throw new Error("invalid Windows cancellation pipe name");
  }
  return name;
}

export class WindowsCancellationAuthenticator<Request, Response> {
  private readonly secret: Buffer;
  private readonly usedNonces = new Map<string, number>();

  constructor(
    private readonly control: WindowsCancellationControl,
    private readonly now: () => number = Date.now,
    private readonly generateNonce: () => string = () => randomBytes(16).toString("hex"),
  ) {
    this.secret = Buffer.from(control.secret, "base64");
    if (this.secret.length !== 32) {
      throw new Error("invalid Windows cancellation control secret");
    }
  }

  createRequest(request: Request): string {
    const nonce = this.generateNonce();
    const issuedAt = this.now();
    const envelope: AuthenticatedRequest<Request> = {
      version: 2,
      generation: this.control.generation,
      nonce,
      issued_at_ms: issuedAt,
      request,
      mac: requestMac(this.secret, this.control.generation, nonce, issuedAt, request),
    };
    return JSON.stringify(envelope);
  }

  acceptRequest(frame: string, handler: (request: Request) => Response): string | null {
    const envelope = parseRequest<Request>(frame);
    if (!envelope || envelope.generation !== this.control.generation) return null;
    if (Math.abs(this.now() - envelope.issued_at_ms) > AUTH_WINDOW_MS) return null;
    if (this.usedNonces.has(envelope.nonce)) return null;
    const expected = requestMac(
      this.secret,
      envelope.generation,
      envelope.nonce,
      envelope.issued_at_ms,
      envelope.request,
    );
    if (!safeEqual(expected, envelope.mac)) return null;
    this.rememberNonce(envelope.nonce);
    const response = handler(envelope.request);
    const signed: AuthenticatedResponse<Response> = {
      version: 2,
      generation: this.control.generation,
      nonce: envelope.nonce,
      response,
      mac: responseMac(
        this.secret,
        this.control.generation,
        envelope.nonce,
        response,
      ),
    };
    return JSON.stringify(signed);
  }

  acceptResponse(requestFrame: string, responseFrame: string): Response | null {
    const request = parseRequest<Request>(requestFrame);
    const response = parseResponse<Response>(responseFrame);
    if (
      !request ||
      !response ||
      response.generation !== this.control.generation ||
      response.nonce !== request.nonce
    ) {
      return null;
    }
    const expected = responseMac(
      this.secret,
      response.generation,
      response.nonce,
      response.response,
    );
    return safeEqual(expected, response.mac) ? response.response : null;
  }

  private rememberNonce(nonce: string): void {
    this.usedNonces.set(nonce, this.now());
    while (this.usedNonces.size > MAX_REPLAY_NONCES) {
      const oldest = this.usedNonces.keys().next().value;
      if (!oldest) break;
      this.usedNonces.delete(oldest);
    }
  }
}

function requestMac<T>(
  secret: Buffer,
  generation: string,
  nonce: string,
  issuedAt: number,
  request: T,
): string {
  return mac(secret, ["request", generation, nonce, String(issuedAt), JSON.stringify(request)]);
}

function responseMac<T>(
  secret: Buffer,
  generation: string,
  nonce: string,
  response: T,
): string {
  return mac(secret, ["response", generation, nonce, JSON.stringify(response)]);
}

function mac(secret: Buffer, values: string[]): string {
  const hmac = createHmac("sha256", secret);
  for (const value of values) {
    hmac.update(value);
    hmac.update("\0");
  }
  return hmac.digest("base64");
}

function safeEqual(expected: string, received: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(received);
  return left.length === right.length && timingSafeEqual(left, right);
}

function parseRequest<T>(frame: string): AuthenticatedRequest<T> | null {
  try {
    const value = JSON.parse(frame) as AuthenticatedRequest<T>;
    if (
      value.version !== 2 ||
      typeof value.generation !== "string" ||
      !/^[0-9A-Za-z-]{16,160}$/u.test(value.nonce) ||
      !Number.isSafeInteger(value.issued_at_ms) ||
      typeof value.mac !== "string" ||
      !value.request ||
      typeof value.request !== "object"
    ) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

function parseResponse<T>(frame: string): AuthenticatedResponse<T> | null {
  try {
    const value = JSON.parse(frame) as AuthenticatedResponse<T>;
    if (
      value.version !== 2 ||
      typeof value.generation !== "string" ||
      typeof value.nonce !== "string" ||
      typeof value.mac !== "string" ||
      !value.response ||
      typeof value.response !== "object"
    ) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

function safeSegment(value: string): string {
  return value.replace(/[^0-9A-Za-z-]/gu, "-").slice(0, 80) || randomUUID();
}
