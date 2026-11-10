/**
 * Durcissement HTTP : en-têtes, validation Host et Origin, réponses neutres.
 *
 * Le service est derrière Pangolin/Traefik, mais aucune de ces protections
 * ne dépend du proxy : elles restent actives même en exposition directe.
 */

const BASE_HEADERS: Readonly<Record<string, string>> = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cross-origin-resource-policy": "same-origin",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'; sandbox",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "permissions-policy": "interest-cohort=()",
};

export function applySecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(BASE_HEADERS)) {
    if (!headers.has(name)) headers.set(name, value);
  }
  // Le handler MCP pose no-cache ; on impose no-store, plus fort, et on garde
  // no-transform pour que le proxy ne réécrive pas les trames SSE.
  headers.set("cache-control", "no-store, no-transform");
  headers.delete("x-powered-by");
  headers.delete("server");
  const body = response.body;
  if (body === null) {
    return new Response(null, { status: response.status, statusText: response.statusText, headers });
  }
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

function hostnameOf(hostHeader: string): string {
  const value = hostHeader.trim().toLowerCase();
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end === -1 ? value : value.slice(0, end + 1);
  }
  const colon = value.indexOf(":");
  return colon === -1 ? value : value.slice(0, colon);
}

/** Protection contre la réécriture du rebinding DNS et les requêtes mal adressées. */
export function hostAllowed(request: Request, allowedHostnames: readonly string[]): boolean {
  const hostHeader = request.headers.get("host");
  if (hostHeader === null) return false;
  const hostname = hostnameOf(hostHeader);
  return allowedHostnames.includes(hostname);
}

/**
 * Validation Origin exigée par la spécification MCP pour le transport HTTP.
 * Sans en-tête Origin (client non navigateur), la requête passe.
 */
export function originAllowed(request: Request, allowedOrigins: readonly string[]): boolean {
  const origin = request.headers.get("origin");
  if (origin === null) return true;
  if (origin === "null") return false;
  return allowedOrigins.includes(origin.trim().toLowerCase());
}

function plain(status: number, error: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export function notFoundResponse(): Response {
  return plain(404, "not_found");
}

export function methodNotAllowedResponse(allow: string): Response {
  return plain(405, "method_not_allowed", { allow });
}

export function forbiddenResponse(): Response {
  return plain(403, "forbidden");
}

export function misdirectedRequestResponse(): Response {
  return plain(421, "misdirected_request");
}

export function payloadTooLargeResponse(maxBytes: number): Response {
  return plain(413, "payload_too_large", { "x-max-body-bytes": String(maxBytes) });
}

export function unsupportedMediaTypeResponse(): Response {
  return plain(415, "unsupported_media_type");
}

export function serverErrorResponse(): Response {
  return plain(500, "internal_error");
}
