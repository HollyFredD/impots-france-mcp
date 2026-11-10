/**
 * Passerelle Node.js <-> web standards.
 *
 * Le handler MCP ne connaît que Request/Response. On traduit ici, avec deux
 * garanties : lecture du corps bornée en octets, et écriture en flux avec
 * contre-pression pour ne pas bufferiser une réponse SSE en mémoire.
 */

import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";

export class BodyTooLargeError extends Error {
  override readonly name = "BodyTooLargeError";
}

export type RequestAdapterOptions = {
  readonly maxBodyBytes: number;
  readonly requestId: string;
  readonly trustProxy: boolean;
};

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const IPV6 = /^[0-9a-f:.]{3,45}$/i;

function firstForwardedFor(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined) return undefined;
  const first = raw.split(",")[0]?.trim();
  if (first === undefined || first === "") return undefined;
  return IPV4.test(first) || IPV6.test(first) ? first : undefined;
}

export function clientAddress(request: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = firstForwardedFor(request.headers["x-forwarded-for"]);
    if (forwarded !== undefined) return forwarded;
  }
  return request.socket.remoteAddress ?? "unknown";
}

function requestProtocol(request: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = request.headers["x-forwarded-proto"];
    const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    if (value !== undefined && /^https?$/i.test(value.trim())) return value.trim().toLowerCase();
  }
  return "http";
}

async function readBody(request: IncomingMessage, maxBodyBytes: number): Promise<Uint8Array> {
  const declared = request.headers["content-length"];
  if (declared !== undefined) {
    const length = Number.parseInt(declared, 10);
    if (Number.isFinite(length) && length > maxBodyBytes) throw new BodyTooLargeError();
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buffer.byteLength;
    if (total > maxBodyBytes) {
      request.destroy();
      throw new BodyTooLargeError();
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export async function toWebRequest(
  request: IncomingMessage,
  options: RequestAdapterOptions,
): Promise<Request> {
  const host = request.headers.host ?? "localhost";
  const protocol = requestProtocol(request, options.trustProxy);
  const target = request.url ?? "/";
  const method = request.method ?? "GET";

  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) headers.set(name, value.join(", "));
    else headers.set(name, value);
  }
  headers.set("x-request-id", options.requestId);

  const hasBody = method !== "GET" && method !== "HEAD";
  const init: RequestInit = { method, headers };
  if (hasBody) init.body = await readBody(request, options.maxBodyBytes);
  return new Request(`${protocol}://${host}${target}`, init);
}

export async function sendWebResponse(
  response: ServerResponse,
  webResponse: Response,
): Promise<void> {
  response.statusCode = webResponse.status;
  response.statusMessage = webResponse.statusText;
  for (const [name, value] of webResponse.headers) response.setHeader(name, value);
  if (webResponse.headers.get("content-type")?.startsWith("text/event-stream") === true) {
    response.setHeader("x-accel-buffering", "no");
    response.flushHeaders();
  }
  response.socket?.setNoDelay(true);

  const body = webResponse.body;
  if (body === null) {
    response.end();
    return;
  }

  const reader = body.getReader();
  const abort = (): void => {
    void reader.cancel().catch(() => {});
  };
  response.once("close", abort);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!response.write(Buffer.from(value))) await once(response, "drain");
    }
  } finally {
    response.off("close", abort);
  }
  response.end();
}
