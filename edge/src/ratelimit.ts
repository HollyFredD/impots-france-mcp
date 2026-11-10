/**
 * Limiteur de débit en mémoire, à fenêtre fixe.
 *
 * Objectif : rendre le bruteforce de jeton inexploitable et borner l'abus.
 * Le service est sans état et mono-instance : une Map suffit, avec une borne
 * mémoire dure pour éviter qu'un attaquant fasse grossir le processus.
 */

export type LimitDecision = {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
};

type Bucket = { count: number; resetAt: number };

export class FixedWindowLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #maxEntries: number;
  readonly #buckets = new Map<string, Bucket>();

  constructor(limit: number, windowMs: number, maxEntries = 10_000) {
    if (limit <= 0) throw new Error("La limite doit être strictement positive.");
    if (windowMs <= 0) throw new Error("La fenêtre doit être strictement positive.");
    this.#limit = limit;
    this.#windowMs = windowMs;
    this.#maxEntries = maxEntries;
  }

  consume(key: string, now = Date.now()): LimitDecision {
    const existing = this.#buckets.get(key);
    if (existing === undefined || existing.resetAt <= now) {
      this.#makeRoom(now);
      this.#buckets.set(key, { count: 1, resetAt: now + this.#windowMs });
      return { allowed: true, retryAfterSeconds: 0 };
    }
    existing.count += 1;
    if (existing.count <= this.#limit) return { allowed: true, retryAfterSeconds: 0 };
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }

  reset(): void {
    this.#buckets.clear();
  }

  #makeRoom(now: number): void {
    if (this.#buckets.size < this.#maxEntries) return;
    for (const [key, bucket] of this.#buckets) {
      if (bucket.resetAt <= now) this.#buckets.delete(key);
    }
    // Toujours saturé : on retire dans l'ordre d'insertion, donc les plus anciens.
    while (this.#buckets.size >= this.#maxEntries) {
      const oldest = this.#buckets.keys().next();
      if (oldest.done === true) break;
      this.#buckets.delete(oldest.value);
    }
  }
}

export function tooManyRequestsResponse(retryAfterSeconds: number): Response {
  return new Response(JSON.stringify({ error: "rate_limited" }), {
    status: 429,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "retry-after": String(Math.max(1, retryAfterSeconds)),
      "cache-control": "no-store",
    },
  });
}
