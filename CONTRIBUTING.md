# Contribuer

Toute modification fiscale passe par une pull request relue et une source primaire officielle.

## Règles

- Ne jamais placer une valeur fiscale dans un handler TypeScript.
- Ne jamais journaliser les arguments ou les résultats d’un outil.
- Ne jamais relâcher un contrôle d’authentification, de débit ou de validation Host sans test associé.
- Conserver les 62 noms et schémas d’entrée tant qu’une version majeure n’est pas décidée.
- Ajouter la période d’effet, la date de contrôle, l’URL et le fondement légal à chaque règle.
- Documenter toute évolution du contrat MCP et fournir les tests de compatibilité associés.

## Vérifications

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
npm run build
npm run check -w edge
docker build -t impots-france-mcp:local .
```
