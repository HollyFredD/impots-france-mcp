# Déploiement de référence : Pangolin et le MCP sur le même hôte

Cette variante ne demande aucun Newt. Elle suppose que Pangolin tourne déjà sur
la machine, avec son réseau Docker `pangolin_frontend`.

Le déploiement de référence sert `https://mcp.farjon.fr/impots`.

## Prérequis

- Docker et Compose sur l'hôte ;
- stack Pangolin active, réseau `pangolin_frontend` créé ;
- DNS du hostname public pointé vers l'hôte ;
- domaine de base déclaré et vérifié dans Pangolin (le certificat wildcard
  couvre alors le sous-domaine).

## Déploiement

```bash
git clone https://github.com/HollyFredD/impots-france-mcp.git
cd impots-france-mcp

cp .env.example .env
chmod 600 .env

# MCP_AUTH_TOKENS=$(openssl rand -base64 48)
# ALLOWED_HOSTNAMES=mcp.example.com
# MCP_PATH=/impots
# TRUST_PROXY=true

cd deploy/vps
docker compose up -d --build
docker compose ps
docker compose logs -f impots-mcp
```

Le conteneur attendu est `Up (healthy)`. La sonde Docker interroge `/healthz`
depuis l'intérieur du conteneur, avec le hostname public en en-tête `Host`.

## Ressource Pangolin

| Champ | Valeur |
| --- | --- |
| Domaine | hostname public, par exemple `mcp.example.com` |
| Cible | site **local**, `impots-mcp:8080`, mode `http` |
| TLS | activé |
| Authentification Pangolin | désactivée |

L'authentification Pangolin doit être désactivée explicitement : une ressource
naît authentifiée. Sinon l'URL répond `401` en `text/plain`, sans atteindre le
serveur MCP.

Détail de la création par API, pièges et vérifications :
[`docs/self-hosting-pangolin.md`](../../docs/self-hosting-pangolin.md).

## Vérification

```bash
TOKEN=$(grep -m1 '^MCP_AUTH_TOKENS=' ../../.env | cut -d= -f2-)
HOST=mcp.example.com
MCP_PATH=/impots

# 401 JSON sans jeton
curl -s -o /dev/null -w '%{http_code}\n' "https://$HOST$MCP_PATH"

# 200 + serverInfo avec jeton
curl -s "https://$HOST$MCP_PATH" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'

# Sonde
curl -s -H "authorization: Bearer $TOKEN" "https://$HOST/healthz"
```

## Mise à jour

```bash
git pull
cd deploy/vps
docker compose up -d --build
```

Relire le diff de `data/*.toml` avant de servir : une règle fiscale obsolète
renvoie un résultat faux, pas une erreur.
