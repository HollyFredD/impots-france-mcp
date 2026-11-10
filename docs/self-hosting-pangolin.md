# Auto-hébergement derrière Pangolin

Ce fork remplace la dépendance à Cloudflare (Workers, Access, Wrangler) par un
serveur Node autonome, protégé par jeton bearer, publié par Pangolin.

Deux topologies sont prises en charge. Le dépôt fournit un fichier compose pour
chacune.

| Topologie | Quand | Fichier |
| --- | --- | --- |
| A. Pangolin sur le même hôte | Pangolin et le serveur MCP tournent sur la même machine (cas du déploiement de référence) | [`deploy/vps/compose.yaml`](../deploy/vps/compose.yaml) |
| B. Pangolin distant | Le serveur MCP est ailleurs, derrière un tunnel | [`compose.yaml`](../compose.yaml) |

## Architecture

### A. Site local (déploiement de référence)

```text
client MCP ──HTTPS──▶ Pangolin (Traefik, TLS)
                          │ réseau Docker pangolin_frontend
                          ▼
                 impots-mcp:8080 (Node, bearer)
```

Aucun conteneur Newt. Traefik partage le réseau Docker du serveur MCP et le joint
par son nom de service. Rien à exposer sur l'hôte : le conteneur ne publie aucun
port.

### B. Tunnel Newt

```text
client MCP ──HTTPS──▶ Pangolin (Traefik, TLS)
                          │ tunnel WireGuard sortant
                          ▼
                      Newt (conteneur sur le VPS MCP)
                          │ réseau Docker interne
                          ▼
                 impots-mcp:8080 (Node, bearer)
```

Newt ouvre la connexion vers Pangolin. Aucun port entrant n'est nécessaire.

## Modèle de menace

| Risque | Contrôle |
| --- | --- |
| Accès anonyme | Jeton bearer obligatoire, y compris sur `/healthz` |
| Bruteforce de jeton | Limite par IP avant vérification, limite par jeton après |
| Fuite de jeton dans les journaux | Aucun journal ne contient l'en-tête, ni le jeton, ni les arguments d'outil |
| Rebinding DNS et Host forgé | Liste blanche d'en-têtes `Host`, réponse 421 sinon |
| Requête pilotée par un navigateur tiers | Validation `Origin`, refus par défaut |
| Corps de requête énorme | Plafond 256 Ko par défaut, refus en flux (413) |
| Slowloris | `headersTimeout` 20 s, `maxHeadersCount` 100 |
| Fuite d'information en erreur | Messages JSON figés, aucune trace interne |
| Données fiscales en clair sur disque | Pas de corps journalisé, conteneur en lecture seule |
| Compromission du conteneur | Utilisateur non root, `cap_drop: ALL`, `no-new-privileges`, système de fichiers en lecture seule |

## 1. Générer les secrets

```bash
openssl rand -base64 48   # un jeton par groupe de devices, pour pouvoir révoquer
```

Un jeton unique pour tout le parc oblige une rotation globale en cas de fuite.
Deux jetons, par exemple « portable » et « téléphone », permettent de révoquer
l'un sans toucher l'autre.

## 2. Préparer le serveur

Le chemin public est réglé par l'application, pas par le proxy : Pangolin ne sait
pas router par préfixe (voir [Limites connues](#limites-connues)). `MCP_PATH` doit
donc correspondre exactement au chemin annoncé aux clients.

```bash
git clone https://github.com/HollyFredD/impots-france-mcp.git
cd impots-france-mcp
cp .env.example .env
chmod 600 .env
```

Renseigner au minimum :

| Variable | Exemple | Rôle |
| --- | --- | --- |
| `MCP_AUTH_TOKENS` | sortie de `openssl rand -base64 48` | jetons acceptés, séparés par virgule |
| `ALLOWED_HOSTNAMES` | `mcp.example.com` | hostname public exact, sans port ni schéma |
| `MCP_PATH` | `/impots` | chemin servi par cette instance |
| `TRUST_PROXY` | `true` | derrière Pangolin, l'IP client vient de `X-Forwarded-For` |

Le déploiement de référence sert `https://mcp.farjon.fr/impots`. Un conteneur
peut servir un autre chemin sur le même hôte, à condition d'avoir sa propre
instance et son propre jeton.

## 3. Déployer

### Topologie A — Pangolin sur le même hôte

Le réseau externe est celui de la stack Pangolin.

```bash
cd deploy/vps
docker compose up -d --build
docker compose logs -f impots-mcp
```

Si le réseau Pangolin porte un autre nom, adapter `networks.pangolin_frontend.name`
dans le fichier compose.

### Topologie B — tunnel Newt

1. Dans Pangolin, créer un site de type **Newt** ; Pangolin affiche `NEWT_ID` et
   `NEWT_SECRET`.
2. Renseigner `PANGOLIN_ENDPOINT`, `NEWT_ID`, `NEWT_SECRET` dans `.env`.
3. Lancer la stack à la racine du dépôt :

```bash
docker compose up -d --build
```

Le journal de démarrage indique le port, le chemin, le nombre d'outils, la
version des données, le nombre de jetons et les hostnames autorisés. Il n'affiche
jamais un jeton.

## 4. Déclarer la ressource dans Pangolin

Créer une ressource **publique** :

| Champ | Valeur de référence |
| --- | --- |
| Domaine | `mcp.farjon.fr` |
| Sous-domaine | `mcp` sur le domaine `farjon.fr` |
| Cible | `impots-mcp:8080` (topologie A, via le site local) ou `impots-mcp:8080` depuis le site Newt (topologie B) |
| Mode | `http` |
| TLS | activé |
| Authentification Pangolin | **désactivée** |

L'authentification Pangolin (Badger) repose sur une session cookie et une page de
connexion navigateur. Un client MCP n'y répond pas : il reçoit du HTML au lieu de
JSON-RPC. L'authentification réelle est le jeton bearer applicatif.

### Piège : la ressource naît authentifiée

À la création, Pangolin applique la politique par défaut et met
l'authentification à `true`. Il faut la désactiver explicitement, sinon l'URL
répond `401 Unauthorized` en `text/plain`, avant même d'atteindre le serveur MCP.

Dans l'interface : décocher l'authentification sur la ressource. Par API :

```bash
curl -s -X POST "https://$PANGOLIN/v1/public-resource/$RESOURCE_ID" \
  -H "authorization: Bearer $PANGOLIN_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"sso":false}'
```

Vérifier ensuite que la ressource porte bien `"sso":false`.

Conséquence directe : l'URL est joignable publiquement. La seule barrière est le
jeton. D'où la limite de débit et le jeton long.

### Piloter Pangolin par API

Pangolin expose deux API distinctes. Les confondre coûte une heure de 401.

| Base | Port | Authentification | Usage |
| --- | --- | --- | --- |
| `/api/v1` | port public | cookie de session | API du dashboard, **refuse les clés** |
| `/v1` | `integration_port`, `3003` par défaut | `Authorization: Bearer <id>.<secret>` | API d'intégration, création de ressources |

L'API d'intégration écoute sur `127.0.0.1:3003` dans le conteneur. Elle n'est pas
publiée. Pour l'appeler, passer par l'intérieur du conteneur :

```bash
docker exec -e PANGOLIN_KEY="<id>.<secret>" pangolin node -e '
const http = require("node:http");
const req = http.request({ host: "127.0.0.1", port: 3003, path: "/v1/orgs",
  headers: { authorization: `Bearer ${process.env.PANGOLIN_KEY}` } },
  (res) => { let b = ""; res.on("data", (c) => (b += c));
    res.on("end", () => console.log(res.statusCode, b)); });
req.end();'
```

La clé se crée dans Pangolin, section API Keys. Elle porte le format
`<apiKeyId>.<secret>` : l'identifiant fait 15 caractères, le secret suit le point.
Une clé `root` a accès à toutes les organisations.

Séquence de création :

1. `GET /v1/orgs` → `orgId` ;
2. `GET /v1/org/{orgId}/domains` → `domainId` du domaine de base ;
3. `GET /v1/org/{orgId}/sites` → `siteId` du site **local** (topologie A) ou du site
   Newt (topologie B) ;
4. `PUT /v1/org/{orgId}/public-resource` avec `name`, `subdomain`, `domainId`, `mode` ;
5. `PUT /v1/public-resource/{resourceId}/target` avec `siteId`, `ip`, `port`, `method` ;
6. `POST /v1/public-resource/{resourceId}` avec `{"sso": false}`.

Le schéma complet est exposé par Pangolin lui-même :
`GET /v1/openapi.yaml` sur le port d'intégration.

## 5. Vérifier

```bash
TOKEN=...                       # un des jetons de MCP_AUTH_TOKENS
HOST=mcp.example.com
MCP_PATH=/impots                # valeur réellement configurée

# Sans jeton : 401 JSON, pas du HTML
curl -s -o /dev/null -w '%{http_code}\n' https://$HOST$MCP_PATH

# Avec jeton : 200 + capacités MCP
curl -s https://$HOST$MCP_PATH \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'

# Sonde
curl -s -H "authorization: Bearer $TOKEN" https://$HOST/healthz
```

Attendu : `401` avec un corps `{"error":"unauthorized"}`, puis `200` avec
`serverInfo`. Un `401` en `text/plain` vient de Pangolin, pas du serveur MCP :
revoir l'étape 4.

Les logs du conteneur confirment aussi le chemin suivi :

```bash
docker logs impots-mcp --tail 5
# {"event":"http_request",...,"route":"mcp","status":200,...}
```

`route` vaut `mcp`, `health` ou `other`. Si toutes les requêtes tombent en `404`,
`MCP_PATH` ne correspond pas à l'URL appelée.

## 6. Brancher les clients

Configuration type d'un client MCP Streamable HTTP :

| Champ | Valeur |
| --- | --- |
| URL | `https://mcp.example.com/impots` |
| Transport | Streamable HTTP |
| En-tête | `Authorization: Bearer <jeton>` |

L'URL est exactement `https://<hostname public><MCP_PATH>`, sans slash final.

`/healthz` sert de sonde et exige aussi le jeton. La sonde Docker l'appelle
depuis l'intérieur du conteneur, avec le hostname public en en-tête `Host`. Elle
utilise `node:http` et non `fetch` : `fetch` supprime silencieusement l'en-tête
`Host`, ce qui déclenche la liste blanche et fait échouer la sonde en 421.

## Exploitation

- **Rotation** : ajouter le nouveau jeton à `MCP_AUTH_TOKENS`, redémarrer,
  migrer les clients, retirer l'ancien, redémarrer. Un jeton accepté est un jeton
  utilisable : aucune autre révocation n'existe.
- **Mise à jour des règles fiscales** : changer de commit, reconstruire l'image,
  relire le diff de `data/*.toml` avant de servir. Une règle obsolète renvoie un
  résultat faux, pas une erreur.
- **Surveillance** : `auth_rejected` avec une IP répétée signale un bruteforce ;
  `token_rate_limited` signale un client emballé ou un jeton fuité.
- **Journalisation** : JSON sur stdout, sans corps ni argument. Un agrégateur
  externe peut les collecter, du moment qu'il ne réécrit pas les en-têtes.
- **Clé API Pangolin** : elle donne les droits d'écriture sur l'infrastructure.
  En créer une dédiée, la révoquer après usage, ne jamais la committer.

## Limites connues

- **Pas de routage par chemin dans Pangolin.** Une ressource Pangolin (EE 1.26)
  est liée à un hôte, pas à un préfixe : `mcp.example.com` en entier pointe vers
  le conteneur. C'est l'application qui restreint la surface à `MCP_PATH` et
  `/healthz` ; tout le reste répond `404`. Deux MCP sur le même hôte exigent donc
  deux sous-domaines, ou une règle Traefik écrite à la main.
- **Pas de serveur d'autorisation OAuth 2.1** : les connecteurs qui exigent une
  découverte OAuth (ChatGPT web, par exemple) ne peuvent pas s'authentifier. Il
  faut soit un client acceptant un en-tête statique, soit ajouter OAuth.
- **Limite de débit en mémoire**, donc par instance. Deux répliques = deux fois la
  limite.
- **Aucune persistance** : le service est sans état, rien à sauvegarder.
- Les calculs restent indicatifs. Ils ne remplacent ni la déclaration préremplie,
  ni un rescrit, ni un conseil personnalisé.
