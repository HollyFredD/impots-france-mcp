/**
 * Authentification bearer, remplace la vérification Cloudflare Access.
 *
 * Choix de conception :
 * - comparaison à temps constant sur des empreintes SHA-256, donc la longueur
 *   du jeton fourni ne fuit pas et le nombre de jetons ne fuit pas non plus
 *   (aucune sortie anticipée dans la boucle) ;
 * - l'identité de journalisation est un préfixe d'empreinte, jamais le jeton ;
 * - un seul en-tête accepté, aucun cookie, aucune session serveur.
 */

import { createHash, timingSafeEqual } from "node:crypto";

const BEARER_PATTERN = /^Bearer[\t ]+([A-Za-z0-9\-._~+/]+=*)$/i;

export type AuthOutcome =
  | { readonly ok: true; readonly subject: string }
  | { readonly ok: false };

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export class BearerVerifier {
  readonly #digests: readonly Buffer[];
  readonly #subjects: readonly string[];

  constructor(tokens: readonly string[]) {
    if (tokens.length === 0) throw new Error("BearerVerifier exige au moins un jeton.");
    this.#digests = tokens.map(digest);
    this.#subjects = this.#digests.map((value) => `token-${value.toString("hex").slice(0, 8)}`);
  }

  get subjects(): readonly string[] {
    return this.#subjects;
  }

  verify(request: Request): AuthOutcome {
    const header = request.headers.get("authorization");
    if (header === null) return { ok: false };
    const match = BEARER_PATTERN.exec(header);
    const presented = match?.[1];
    if (presented === undefined) return { ok: false };

    const candidate = digest(presented);
    let found = -1;
    for (let index = 0; index < this.#digests.length; index += 1) {
      const expected = this.#digests[index];
      if (expected !== undefined && timingSafeEqual(candidate, expected)) found = index;
    }
    if (found === -1) return { ok: false };
    const subject = this.#subjects[found];
    return subject === undefined ? { ok: false } : { ok: true, subject };
  }
}

export function unauthorizedResponse(): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "www-authenticate": 'Bearer realm="impots-france-mcp"',
      "cache-control": "no-store",
    },
  });
}
