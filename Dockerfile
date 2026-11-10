# syntax=docker/dockerfile:1

# --- Étape 1 : compilation du moteur Rust en WebAssembly, puis du serveur Node
FROM node:22-bookworm-slim AS build

ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH \
    CARGO_TERM_COLOR=never

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl build-essential \
 && rm -rf /var/lib/apt/lists/* \
 && curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --profile minimal --default-toolchain 1.95.0 \
 && rustup target add wasm32-unknown-unknown

WORKDIR /app

COPY package.json package-lock.json ./
COPY edge/package.json edge/
RUN npm ci --ignore-scripts=false

COPY crates ./crates
COPY contracts ./contracts
COPY data ./data
COPY scripts ./scripts
COPY edge ./edge
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./

RUN npm run build

# --- Étape 2 : image d'exécution, sans chaîne de compilation
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080

WORKDIR /app

COPY package.json package-lock.json ./
COPY edge/package.json edge/
RUN npm ci --omit=dev \
 && npm cache clean --force

COPY --from=build /app/edge/dist ./edge/dist

USER node

EXPOSE 8080

# La sonde réutilise le hostname public autorisé : le contrôle Host reste actif.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "const token=(process.env.MCP_AUTH_TOKENS||'').split(',')[0];const host=(process.env.ALLOWED_HOSTNAMES||'').split(',')[0];if(!token||!host)process.exit(1);fetch('http://127.0.0.1:'+(process.env.PORT||8080)+(process.env.HEALTH_PATH||'/healthz'),{headers:{authorization:'Bearer '+token,host}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "edge/dist/index.js"]
