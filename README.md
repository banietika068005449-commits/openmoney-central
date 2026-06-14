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
