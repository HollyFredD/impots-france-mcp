# Auto-hébergement derrière Pangolin

Ce fork remplace la dépendance à Cloudflare (Workers, Access, Wrangler) par un
serveur Node autonome, protégé par jeton bearer, destiné à être publié via
Pangolin et son tunnel Newt.

## Architecture

```text
client MCP ──HTTPS──▶ Pangolin (Traefik, TLS)
                          │
                          │ tunnel WireGuard sortant
                          ▼
                      Newt (conteneur sur le VPS)
                          │ réseau Docker interne
                          ▼
                 impots-mcp:8080 (Node, bearer)
```

Newt ouvre la connexion vers Pangolin. Aucun port entrant n'est nécessaire sur
le VPS, aucune règle de pare-feu à ajouter, aucune adresse publique à exposer.

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

## 2. Créer le site Newt dans Pangolin

Dans Pangolin, créer un site de type **Newt**. Pangolin affiche `NEWT_ID` et
`NEWT_SECRET` : ce sont les seules valeurs à copier dans `.env`.

## 3. Déclarer la ressource

Ressource publique Pangolin :

| Champ | Valeur |
| --- | --- |
| Domaine | `mcp.example.com` |
| Cible | `http://impots-mcp:8080` |
| TLS | activé (certificat Pangolin/Traefik) |

**Authentification Pangolin : désactivée sur cette ressource.** L'authentification
Pangolin (Badger) repose sur une session cookie et une page de connexion
navigateur ; un client MCP n'y répond pas, il reçoit du HTML au lieu de JSON-RPC.
L'authentification réelle est le jeton bearer applicatif, décrit plus haut.

Conséquence directe : l'URL est joignable publiquement. La seule barrière est le
jeton. D'où la limite de débit et le jeton long.

## 4. Déployer

```bash
cp .env.example .env
chmod 600 .env
# renseigner MCP_AUTH_TOKENS, ALLOWED_HOSTNAMES, PANGOLIN_ENDPOINT, NEWT_ID, NEWT_SECRET
docker compose up -d --build
docker compose logs -f impots-mcp
```

Le journal de démarrage indique le port, le nombre d'outils, la version des
données, le nombre de jetons et les hostnames autorisés. Il n'affiche jamais un
jeton.

## 5. Vérifier

```bash
TOKEN=...                     # un des jetons de MCP_AUTH_TOKENS
HOST=mcp.example.com

# Sans jeton : 401
curl -s -o /dev/null -w '%{http_code}\n' https://$HOST/mcp

# Avec jeton : 200 + capacités MCP
curl -s https://$HOST/mcp \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
```

## 6. Brancher les clients

Configuration type d'un client MCP Streamable HTTP :

| Champ | Valeur |
| --- | --- |
| URL | `https://mcp.example.com/mcp` |
| Transport | Streamable HTTP |
| En-tête | `Authorization: Bearer <jeton>` |

`/healthz` sert de sonde et exige aussi le jeton. La sonde Docker l'appelle
depuis l'intérieur du conteneur, avec le hostname public en en-tête `Host`.

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

## Limites connues

- Pas de serveur d'autorisation OAuth 2.1 : les connecteurs qui exigent une
  découverte OAuth (ChatGPT web, par exemple) ne peuvent pas s'authentifier. Il
  faut soit un client acceptant un en-tête statique, soit ajouter OAuth.
- Limite de débit en mémoire, donc par instance. Deux répliques = deux fois la
  limite.
- Aucune persistance : le service est sans état, rien à sauvegarder.
- Les calculs restent indicatifs. Ils ne remplacent ni la déclaration préremplie,
  ni un rescrit, ni un conseil personnalisé.
