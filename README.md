# Impôts France MCP — fork auto-hébergé

> Serveur MCP pour interroger 62 outils fiscaux français, avec des calculs Rust
> et des règles officielles sourcées et versionnées.

Ce fork remplace le déploiement Cloudflare d'origine par un serveur Node
autonome, durci, destiné à être publié via **Pangolin**. Le moteur fiscal, les
contrats d'outils et les registres de règles sont inchangés.

- Guide de déploiement : [`docs/self-hosting-pangolin.md`](docs/self-hosting-pangolin.md)
- Sécurité : voir la section [Sécurité](#sécurité) ci-dessous.

## Connexion

Dans un client compatible **MCP Streamable HTTP**, ajouter un serveur :

| Champ | Valeur |
| --- | --- |
| Nom | `Impôts France` |
| Transport | Streamable HTTP |
| URL | `https://<votre-domaine>/mcp` |
| Authentification | `Authorization: Bearer <jeton>` |

Sans jeton valide, l'endpoint répond `401 Unauthorized`. Le schéma d'API des
62 outils est décrit dans [`contracts/tools.json`](contracts/tools.json).

## Exemples d'utilisation

Les demandes peuvent combiner plusieurs outils. Indiquer l'année concernée et
les données connues améliore la précision de la simulation.

### Impôt sur le revenu et PER

```text
Estime l'impôt d'un couple marié avec deux enfants, 62 000 € et 38 000 € de salaires nets imposables. Compare la situation avant et après un versement de 5 000 € sur un PER. Détaille le quotient familial, le taux marginal, les hypothèses et les sources.
```

### Dividendes et placements

```text
Compare le prélèvement forfaitaire unique et le barème progressif pour 12 000 € de dividendes, avec 38 000 € d'autres revenus imposables, pour un célibataire sans enfant. Présente les deux scénarios et l'écart estimé.
```

### Plus-value immobilière

```text
Simule la vente d'un logement locatif pour 330 000 €, acheté 210 000 € et détenu 14 ans. Intègre 15 000 € de frais d'acquisition et 28 000 € de travaux justifiés. Sépare impôt sur le revenu, prélèvements sociaux, abattements et surtaxe éventuelle.
```

### Cryptomonnaies

```text
Calcule la plus-value imposable pour une cession de 18 000 €. Avant la cession, le portefeuille vaut 72 000 € et son prix total d'acquisition est de 41 000 €. Ajoute 900 € de revenus de staking et précise le traitement fiscal retenu.
```

### Transmission

```text
Estime les droits pour une donation de 120 000 € d'un parent à son enfant. Compare une donation classique et un don familial de somme d'argent selon l'âge du donateur, les abattements disponibles et les donations antérieures.
```

Ces exemples sont des scénarios d'utilisation, pas des résultats fiscaux de
référence.

## Fonctionnement

Chaque outil renvoie une réponse Markdown et un `structuredContent` exploitable
par le client. Les résultats précisent la version des données, la période
d'effet, les hypothèses, les avertissements et les sources officielles utilisées.

Garanties principales :

- contrats d'outils versionnés et testés ;
- opérations en lecture seule, non destructives et idempotentes ;
- calculs exécutés en Rust puis compilés en WebAssembly ;
- règles rattachées à une source officielle et à une période d'effet ;
- arguments fiscaux et résultats personnels non journalisés.

Si un calcul exige une donnée locale, conventionnelle ou individuelle absente,
le serveur signale la limite au lieu d'inventer une valeur.

## Architecture

```text
Client MCP → Pangolin (TLS) → tunnel Newt → Node/HTTP → WebAssembly → moteur Rust → registres TOML
```

L'adaptateur TypeScript expose MCP et valide les schémas. Le moteur Rust applique
les règles contenues dans les registres TOML datés.

## Sécurité

Le serveur applique, sans dépendre du proxy :

- authentification bearer à temps constant, plusieurs jetons possibles ;
- limite de débit par IP puis par jeton ;
- liste blanche d'en-têtes `Host` et validation `Origin` ;
- plafond de corps de requête appliqué en flux, réponse `413` ;
- délais d'attente d'en-têtes, nombre d'en-têtes borné ;
- en-têtes de réponse figés, `cache-control: no-store`, aucune bannière serveur ;
- erreurs génériques, sans trace interne ni donnée saisie ;
- journaux sans corps, sans argument d'outil, sans jeton ;
- conteneur non root, lecture seule, capacités retirées.

La configuration est validée au démarrage : jeton trop court, jeton d'exemple,
hostname joker ou valeur hors bornes provoquent un arrêt immédiat.

## Développement

Prérequis : Rust `1.95.0`, Node.js `22` ou supérieur, npm et `wasm-pack`.

```bash
git clone https://github.com/HollyFredD/impots-france-mcp.git
cd impots-france-mcp
npm ci
npm run build
npm run check
```

`npm run check` contrôle le formatage, Clippy, les tests Rust, les contrats MCP
et l'adaptateur TypeScript.

Exécution locale :

```bash
MCP_AUTH_TOKENS="$(openssl rand -base64 48)" \
ALLOWED_HOSTNAMES=localhost \
HOST=127.0.0.1 PORT=8080 \
npm start
```

Variante stdio, pour un client local : `npm run start:stdio`.

Déploiement conteneurisé : voir [`docs/self-hosting-pangolin.md`](docs/self-hosting-pangolin.md).
Toute modification fiscale doit être sourcée, testée et relue selon
[`CONTRIBUTING.md`](CONTRIBUTING.md).

## Limites et licence

Ces simulations ne remplacent ni une déclaration préremplie, ni un rescrit, ni un
conseil personnalisé. Pour une décision importante, vérifier les textes
applicables auprès de la DGFiP ou d'un professionnel qualifié.

Projet distribué sous licence [MIT](LICENSE). Fork de
[murillo-consulting/impots-france-mcp](https://github.com/murillo-consulting/impots-france-mcp).
