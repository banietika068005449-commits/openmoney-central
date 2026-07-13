# OpenMoney Analysis Worker

Worker Node.js qui interroge en boucle une base Postgres (table `sms`, alimentee par un autre systeme), analyse chaque SMS Mobile Money via des regex specifiques par operateur ou via un LLM en fallback, et ecrit le resultat structure dans la table `sms_analysis`.

Aucun HTTP, aucun WebSocket, aucun modem — c'est un moteur d'analyse pur, conçu pour etre deploye en ligne.

## Architecture

```
[Base A : table `sms`]   <-- alimentee par un autre systeme
        |
        | (polling toutes les POLL_INTERVAL_MS, status='received')
        v
[Worker OpenMoney]  --->  [Registry : MTN / Airtel / AI / Unknown]
        |
        v
[Base B : table `sms_analysis`]
```

A chaque tick :
1. `SELECT id FROM sms WHERE status='received' LIMIT BATCH_SIZE`
2. Pour chaque id : `BEGIN ; SELECT ... FOR UPDATE SKIP LOCKED ; UPDATE status='processing' ; analyze ; INSERT INTO sms_analysis ; UPDATE status='analyzed' | 'ignored' ; COMMIT`
3. En cas d'erreur dans le provider : `ROLLBACK` puis `UPDATE status='failed'`.

`SKIP LOCKED` rend le worker safe en cas de multiples instances.

## Recherche Admin

Le dashboard Admin utilise `GET /sms` comme source complete des trames recues.
Cette route part de la table brute `sms` avec une jointure gauche vers
`sms_analysis`, afin qu'une trame recue par l'API reste visible meme si son
analyse est absente ou incomplete.

- `q`, `phone` et `transactionId` cherchent aussi dans `sms.sender`,
  `sms.content`, `sms.point_de_vente` et `sms.uuid`.
- Les filtres qui dependent de champs calcules (`amount`, `operatorPrefix`,
  `imei`, `tecno`) restent limites aux lignes qui possedent les donnees
  d'analyse correspondantes.
- Les routes `/api/analysis/summary` et `/api/analysis/sms` restent centrees sur
  les transactions analysees, pour conserver la compatibilite mobile/support.

## Prerequis
- Node.js 20+
- Une base Neon Postgres (la meme pour A et B)

## Installation
```
npm install
cp .env.example .env
# editer .env (DATABASE_URL, POLL_INTERVAL_MS, BATCH_SIZE)
npm run migrate   # cree sms_analysis + ai_provider + ai_provider_key (et sms si manquante)
npm start
```

## Variables d'environnement

| variable            | defaut  | role                                                    |
| ------------------- | ------- | ------------------------------------------------------- |
| `DATABASE_URL`      | (requis)| Postgres connection string (Neon)                       |
| `POLL_INTERVAL_MS`  | `5000`  | Intervalle entre deux passes du worker                  |
| `BATCH_SIZE`        | `50`    | Nombre de SMS traites par passe                         |

### Synchro TECNO « Tecno Ya Niongo »

| variable                       | defaut                                | role                                                              |
| ------------------------------ | ------------------------------------- | ---------------------------------------------------------------- |
| `TECNO_PARTNER_API_KEY`        | (aucun)                               | Cle partenaire, envoyee en header `x-api-key`. **Secret** — jamais en dur, jamais loggee. Absente ⇒ synchro desactivee. |
| `TECNO_PARTNER_BASE_URL`       | `https://tecno-api-6z50.onrender.com` | Base de l'API partenaire                                          |
| `TECNO_PARTNER_TIMEOUT_MS`     | `15000`                               | Timeout par requete                                              |
| `TECNO_SYNC_ENABLED`           | `true`                                | Mettre `false` pour desactiver la synchro sans retirer la cle    |
| `TECNO_SYNC_INTERVAL_MS`       | `900000`                              | Cadence incrementale (15 min)                                    |
| `TECNO_SYNC_FULL_INTERVAL_MS`  | `86400000`                            | Cadence du resync plein (24 h)                                   |

## Module TECNO — synchro des numeros partenaire

Le module TECNO importe automatiquement les **numeros de telephone** des clients
depuis l'API « Tecno Ya Niongo » (`GET /partner/devices`, header `x-api-key`) et
les stocke dans la Liste TECNO (`client_tecno`, `auto=true`, `source='partner'`).
Ces numeros sont donc marques TECNO en permanence, comme les numeros saisis a la main.

- **Amorcage** : au demarrage, resync plein si jamais synchronise, sinon incremental.
- **Incremental** (15 min) : `updatedSince` = horodatage de la derniere execution
  reussie (l'API ne renvoyant pas de date). Resync plein quotidien pour rattraper
  les ecarts.
- **Dedup + idempotence** : numeros dedupliques (Set) puis UPSERT sur le numero —
  deux executions ne creent pas de doublons.
- **Erreurs** : `401` (cle invalide) et `503` (acces non configure cote Tecno) sont
  loggees en **alerte** sans retry ; reseau/`5xx` font l'objet de retries backoff.
  Le dernier etat est expose a l'UI Admin (page TECNO) et via `GET /tecno/sync-status`.

Note : retirer un numero partenaire de la Liste TECNO le supprime, mais un **resync
plein** le reajoutera s'il est toujours present chez Tecno (comportement attendu).

### Declenchement manuel

```
# incremental (defaut)
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" http://localhost:3001/tecno/sync
# resync plein
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" "http://localhost:3001/tecno/sync?mode=full"
# statut
curl -H "Authorization: Bearer $ADMIN_TOKEN" http://localhost:3001/tecno/sync-status
```

Appel direct a l'API partenaire (verification d'acces) :

```
curl -H "x-api-key: $TECNO_PARTNER_API_KEY" "https://tecno-api-6z50.onrender.com/partner/devices?take=200&skip=0"
```

> **Securite** : les numeros sont des donnees personnelles. Restreindre l'acces a la
> table `client_tecno`, activer le chiffrement au repos cote hebergeur Postgres, et ne
> jamais journaliser la cle partenaire.

## Configuration des providers AI

Pas d'interface : on insere directement en SQL.

```sql
INSERT INTO ai_provider (name, provider_type, model)
VALUES ('OpenAI GPT-4o-mini', 'openai', 'gpt-4o-mini');

INSERT INTO ai_provider_key (provider_id, label, api_key)
VALUES (1, 'prod', 'sk-...');
```

Le worker rafraichit la liste des cles actives toutes les 60s.

## Structure du code

- `src/index.js`                    — boucle de polling + shutdown propre
- `src/db.js`                       — pool Postgres + helpers
- `src/analysis/service.js`         — orchestration transactionnelle
- `src/analysis/registry.js`        — selection du provider (premier qui `canAnalyze`)
- `src/analysis/providers/mtn.js`   — regex MTN MoMo
- `src/analysis/providers/airtel.js`— regex Airtel Money
- `src/analysis/providers/ai.js`    — fallback LLM (OpenAI/Anthropic/Google/Mistral)
- `src/analysis/providers/unknown.js`— dernier filet, marque "ignored"
