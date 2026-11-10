// Copie le paquet wasm-pack généré dans dist/, pour que le JS compilé par tsc
// trouve ./generated/wasm/fiscal_wasm.js et le binaire .wasm au même endroit
// qu'en source. Sans cette étape, `npm start` échoue sur une résolution ESM.

import { cp, mkdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../edge/src/generated/wasm", import.meta.url));
const target = fileURLToPath(new URL("../edge/dist/generated/wasm", import.meta.url));

try {
  await stat(fileURLToPath(new URL("../edge/src/generated/wasm/fiscal_wasm_bg.wasm", import.meta.url)));
} catch {
  throw new Error(
    "Paquet wasm absent : exécute `npm run build:wasm` avant `npm run build -w edge`.",
  );
}

await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });
console.log(`wasm copié vers ${target}`);
