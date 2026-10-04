# Agentic City

Live deployment: [agentic-city.vercel.app](https://agentic-city.vercel.app/)

[![CI](https://github.com/Bitcoindefi/Open-Stellar/actions/workflows/ci.yml/badge.svg)](https://github.com/Bitcoindefi/Open-Stellar/actions/workflows/ci.yml)
[![Quality Gate Status](https://sonarcloud.io/api/project_badges/measure?project=Bitcoindefi_Open-Stellar&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=Bitcoindefi_Open-Stellar)
[![Coverage](https://sonarcloud.io/api/project_badges/measure?project=Bitcoindefi_Open-Stellar&metric=coverage)](https://sonarcloud.io/summary/new_code?id=Bitcoindefi_Open-Stellar)

Agentic City es una consola gamificada para conectar un agente orquestador por API, sumar workers especializados, y operar wallets, pagos, skills, reputación y modelos de IA como una arena de agentes. Nació como Open Stellar y conserva Stellar como rail principal, ahora con Solana, CosmosPay, x402, JEV y compatibilidad EVM dentro de una visión multichain.

[![Deploy to Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fbitcoindefi%2FOpen-Stellar&project-name=agentic-city&repository-name=agentic-city&env=NEXT_PUBLIC_NODE_NAME%2CSTELLAR_NETWORK%2CNEXT_PUBLIC_WALLETCONNECT_PROJECT_ID%2CADMIN_API_KEY&envDescription=Agentic+City+node+configuration&envLink=https%3A%2F%2Fgithub.com%2Fbitcoindefi%2FOpen-Stellar%23variables-de-entorno)

---

## Stack

| Capa      | Tecnología                                                    |
| --------- | ------------------------------------------------------------- |
| Framework | Next.js 16 (modo webpack — requerido por snarkjs)             |
| UI        | React 19, Tailwind v4, Radix UI, Framer Motion                |
| Stellar   | @stellar/stellar-sdk v16, @stellar/freighter-api, Soroban RPC |
| Solana    | Browser wallet provider rail (Phantom / Solflare compatible)  |
| ZK        | snarkjs 0.7.6, Groth16/BN254, circom (WASM artifacts)         |
| EVM       | wagmi, viem, WalletConnect                                    |
| CosmosPay | Stellar SEP-7 payment intents via `@cosmosapp/pay_sdk`        |
| AI        | Vercel AI Gateway + TypeSafe AI JEV for typed evaluations     |
| Deploy    | Vercel (Next.js, auto-detect)                                 |

---

## Arquitectura

```
Browser
 ├─ Wallet (MetaMask / WalletConnect / Freighter / Phantom / Solflare)
 ├─ Admin Console
 │ ├─ Tab: Orchestration Overview (métricas, squads, suscripciones)
 │ ├─ Tab: Cloud Agents (agente orquestador por API, workers, JEV BYOK)
 │ ├─ Tab: Agent Passport (ZK) (mint, verify, x402 gate, replay demo)
 │ └─ Tab: Private Deploy (API reference, one-click deploy)
 └─ Hub UI (mapa de agentes, distrito, telemetría)

API Routes (Next.js)
 ├─ /api/protocol/x402/quote GET – crea quote de pago
 ├─ /api/protocol/x402/settle POST – liquida pago (+ passport gate opcional)
 ├─ /api/protocol/passport/authorize POST – verifica spend-cap ZK on-chain
 ├─ /api/protocol/passport/status GET – lee attestation del agente
 ├─ /api/protocol/reputation GET/POST – sistema de reputación
 ├─ /api/protocol/track8004 GET – resolución ERC-8004
 ├─ /api/events GET – stream SSE de eventos del canvas
 ├─ /api/events/:agentId GET – stream SSE filtrado por agente
 ├─ /api/agents/:id/heartbeat POST – heartbeat runtime del agente
 ├─ /api/agents/:id/health GET – estado healthy/stale/offline
 ├─ /api/cron/health-check GET – marca agentes offline y dispara alertas
 ├─ /api/stellar/balance GET – balance Stellar
 ├─ /api/stellar/build-tx POST – construye transacción
 ├─ /api/stellar/submit-tx POST – envía transacción firmada
 └─ /api/stellar/fund POST – Friendbot testnet

Contratos Soroban (testnet)
 ├─ AgentPassportValidator CDNSZUNEWFCGSPWLPDSWTENR2WPHKC34RGZQG7RJA54OPGTZGVVRFYBA
 └─ CircomGroth16Verifier CCMKLYSRUH2HMA4UU6WLXWQXEY6KAH5AWB5BEVMJGNGC5GLGTVROLG4A
```

---

## Protocolos

### x402 — HTTP payment gate

Cada llamada a un servicio de agente queda protegida por una microtransacción XLM. El flujo es:

1. Cliente solicita quote → `GET /api/protocol/x402/quote`
2. Paga on-chain
3. Envía evidencia de settlement → `POST /api/protocol/x402/settle`
4. La API verifica y emite receipt

El settle acepta `agentId` opcional; si está presente, llama al gate de passport antes de liquidar. Requests sin `agentId` mantienen comportamiento original (retrocompatible).

Archivos: [lib/protocols/x402.ts](lib/protocols/x402.ts), [app/api/protocol/x402/](app/api/protocol/x402/)

### Receipts explorer (Solana devnet)

The public explorer at `/explorer` lists every x402 payment, agent-to-agent hire and 8004 registration or review on Solana devnet, each linked to its transaction on Solana Explorer, with totals (payments, USDC volume, hires, reviews, registered agents, unique payers) and a per-agent filter (`/explorer?agent=<id>`).

- Each event appends a small public record (type, tx, amount, agent id and name, short payer address, time; never prompts or task text) to a capped Redis list (last 500), best-effort so it never fails the payment.
- Treasury activity from before the log existed is read back from the chain (`getSignaturesForAddress` on the treasury USDC account and wallet) and shown as "leído de la cadena". Set `RECEIPTS_ONCHAIN_BACKFILL=off` to disable it.
- `GET /api/receipts?type=payment|hire|registration|review&agent=<id>&page=1&pageSize=25` serves the same data (public, cached about 10 seconds).

The legacy Stellar-era registry is still served at `GET /api/explorer/receipts`.

Archivos: [app/explorer/page.tsx](app/explorer/page.tsx), [components/explorer/receipts-explorer.tsx](components/explorer/receipts-explorer.tsx), [app/api/receipts/route.ts](app/api/receipts/route.ts), [lib/receipts/](lib/receipts/)

### Agent Passport (ZK) — capa de confianza zero-knowledge

Cada agente puede acuñar un **pasaporte Groth16** que prueba — sin revelar la identidad del dueño ni el saldo real — que está respaldado por un humano verificado y es solvente hasta su spend cap.

Las cuatro invariantes on-chain:

- Prueba Groth16 válida (verificada por CircomGroth16Verifier en Soroban)
- Nullifier anti-replay (un pasaporte, un uso)
- Membresía en el identity registry
- Proof-of-funds para el spend cap declarado

Flujo en el browser:

1. Se genera un keypair efímero (`privateKey`, `agentId`)
2. snarkjs calcula el witness y genera la prueba WASM local
3. La prueba se envía al validador Soroban para attestation on-chain
4. El x402 settle gate consulta el spend cap antes de cada pago

Archivos: [lib/passport/passport.ts](lib/passport/passport.ts), [lib/passport/validator-client.ts](lib/passport/validator-client.ts), [public/zk/](public/zk/), [components/admin/passport-panel.tsx](components/admin/passport-panel.tsx)

Rutas API: [app/api/protocol/passport/](app/api/protocol/passport/)

### Track 8004 + Reputación

Resolución de identidad de agentes siguiendo el estándar ERC-8004. Si la cadena no soporta 8004 nativo, el sistema hace fallback automático al motor de reputación en Stellar.

Archivos: [lib/protocols/track8004.ts](lib/protocols/track8004.ts), [lib/reputation/reputation-store.ts](lib/reputation/reputation-store.ts)

### Price feed

`GET /api/prices` returns a 60-second cached CoinGecko free-tier quote for XLM, BTC, and USDC. The canvas uses the same feed through `usePrices()` and `PriceTicker` so operators can see live USD context for XLM-denominated agent earnings and x402 service prices without configuring an API key.

Relevant files: [lib/prices/coingecko.ts](lib/prices/coingecko.ts), [app/api/prices/route.ts](app/api/prices/route.ts), [hooks/use-prices.ts](hooks/use-prices.ts), [components/price-display.tsx](components/price-display.tsx)

### Agent Health Monitoring

Cada agente puede publicar un heartbeat cada 15 segundos en `POST /api/agents/:id/heartbeat` con `status`, `cpu`, `memory`, `currentTask` y `autoRestart`. `GET /api/agents/:id/health` devuelve un snapshot con `healthy`, `stale` u `offline`, los missed heartbeats, uptime y ultimo heartbeat observado.

La ruta `GET /api/cron/health-check` esta pensada para Vercel Cron. Marca offline a los agentes sin heartbeat por mas de 45 segundos, registra eventos `agent.status`, solicita auto-restart cuando `autoRestart` esta activo, y eleva alertas `error` cuando un agente lleva mas de 5 minutos offline. Vercel ejecuta la ruta cada minuto mediante `vercel.json`; entornos self-hosted pueden llamarla cada 30 segundos.

Archivos: [lib/agents/agent-health-store.ts](lib/agents/agent-health-store.ts), [app/api/agents/](app/api/agents/), [app/api/cron/health-check/](app/api/cron/health-check/)

### Autenticación y Gestión de API Keys (Zero-Trust)

Agentic City implementa un modelo de autenticación y autorización máquina a máquina cerrado por defecto (_closed-by-default_).

#### Niveles de Claves

- **Admin Key (`ADMIN_API_KEY`)**: Secreto del servidor para acceder a `/admin/*`. Configúralo en las variables protegidas de Vercel y en `.env.local` para desarrollo; nunca lo pongas en URLs, código cliente ni `NEXT_PUBLIC_*`.
- **Service Keys (`osk_live_...`)**: Claves emitidas con scopes específicos (`x402:quote`, `x402:settle`, `agents:read`, `agents:write`, `webhooks:manage`, `quests:manage`).

#### Autenticación en Requests

Las solicitudes se autentican mediante header:

```http
Authorization: Bearer osk_live_...
```

La consola web inicia sesión en `/admin/login`. La clave se valida en el servidor y se intercambia por una cookie `HttpOnly` de ocho horas; no se guarda en `localStorage` ni en la URL. `DEV_MODE=true` solo omite autenticación en desarrollo y no abre el panel en producción.

#### Rate Limits por Tier (Sliding Window)

| Tier   | Requests/min |
| ------ | ------------ |
| No key | 10           |
| Free   | 60           |
| Pro    | 600          |
| Admin  | unlimited    |

#### Seguridad y Garantías

- **Almacenamiento Hashed**: Las claves se guardan hasheadas con SHA-256 (`lib/auth/api-keys.ts`). Ninguna clave en texto plano queda almacenada.
- **Comparación en Tiempo Constante**: Se utiliza `timingSafeEqual` para prevenir ataques de canal lateral (_timing attacks_).
- **Visualización Única**: El secreto completo se muestra una única vez al emitirse o rotarse; posteriormente solo se expone el prefijo sanitizado (`osk_live_abc123...`).
- **Revocación Inmediata**: La revocación invalida el acceso instantáneamente en el middleware.
- **Consola de Administración**: Interfaz gráfica en `/admin/keys` para emitir, inspeccionar, revocar y rotar credenciales.

### Escrow

| Contrato                                                       | Red     | Función                                                      |
| -------------------------------------------------------------- | ------- | ------------------------------------------------------------ |
| [EscrowMilestone.sol](contracts/evm/EscrowMilestone.sol)       | EVM     | Escrow por hitos (createDeal, release, refund, raiseDispute) |
| [X402ServicePaywall.sol](contracts/evm/X402ServicePaywall.sol) | EVM     | Paywall x402 (settle402, hasPaid, withdraw)                  |
| [escrow/src/lib.rs](contracts/stellar/escrow/src/lib.rs)       | Soroban | Base funcional (create, release, dispute, get)               |

---

## Admin Console

Accesible en `/admin`. Tres tabs:

## Accessibility

The canvas exposes keyboard-focusable agent targets with ARIA labels, the sidebar agent list uses listbox/option semantics, and `prefers-reduced-motion` disables transaction line animations. Color-blind status shapes can be enabled with `?colorblind=true` or persisted through the sidebar toggle, which stores `colorblind-mode` in localStorage.

### Orchestration Overview

Vista operativa del stack como SaaS: squads de agentes por distrito, telemetría de CPU/memoria, planes de suscripción (Starter $49/mo → Growth $249/mo → Command custom), uso mensual de requests y API key con scope completo.

### Agent Passport (ZK)

Panel interactivo de 4 pasos:

1. **Mint** — genera prueba Groth16 en el browser
2. **Verify on-chain** — consulta attestation en Soroban testnet
3. **Authorize x402** — gate de spend cap contra el validador
4. **Replay attack demo** — demuestra que el nullifier bloquea reusos

Muestra contratos desplegados en testnet con links a stellar.expert.

### Private Deploy

Para desarrolladores que quieren su propio nodo Agentic City:

- Guía de 3 pasos (Fork → Configure → Deploy)
- Botón "Deploy to Vercel" de un click
- Tabla completa de endpoints API con método y descripción
- Variables de entorno requeridas
- Snippet curl de test

---

## Quickstart CLI

Scaffold a new node in one command:

```bash
npx create-open-stellar-app my-node
```

Prompts for node name, network (`testnet` / `mainnet`), and deploy target (`Vercel` / `Docker` / `local-only`). The CLI creates `.env.local`, configures `vercel.json` when needed, and generates an admin API key.

---

## Variables de entorno

```env
# Display name in admin console header
NEXT_PUBLIC_NODE_NAME=My Agentic City Node

# Stellar network
STELLAR_NETWORK=testnet

# WalletConnect Cloud project ID (requerido para conectores EVM)
NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=abc123...

# Admin API key (required for the admin console; keep server-side and out of git)
ADMIN_API_KEY=osk_...

# URL pública del deployment (opcional, usado en metadata)
NEXT_PUBLIC_APP_URL=https://agentic-city.vercel.app

# Local mock mode (opcional): evita llamadas reales a Stellar, x402 y Passport
NEXT_PUBLIC_MOCK_MODE=false

# Better Stack / Logtail structured API logs (opcional)
LOGTAIL_SOURCE_TOKEN=logtail-source-token

# Custom EVM RPC URLs for x402 settlement (opcional)
NEXT_PUBLIC_BNB_RPC_URL=https://tu-rpc-bnb.com
NEXT_PUBLIC_BASE_RPC_URL=https://tu-rpc-base.com
```

Obtener WalletConnect project ID en [cloud.walletconnect.com](https://cloud.walletconnect.com).

### Local mock mode

Set `NEXT_PUBLIC_MOCK_MODE=true` in `.env.local` to run the local demo without live Stellar testnet, Friendbot, Soroban, or x402 settlement calls. Mock mode returns a fixed funded Stellar balance, mock transaction hashes, mock x402 receipts, and mock passport attestations. A yellow banner appears at the top of the app so operators do not mistake mock responses for real payments.

### Observabilidad de API

Las rutas bajo `/api/protocol/*` y `/api/stellar/*` emiten logs estructurados mediante Better Stack / Logtail cuando `LOGTAIL_SOURCE_TOKEN` está configurado. La app tambien envuelve `next.config.mjs` con `withLogtail` para habilitar la integracion de Next.js. Si la variable no existe, el logger queda en modo no-op para desarrollo local.

Campos base incluidos en cada evento:

- `route`, `method`, `path`, `status`, `durationMs`
- `event`, `reason` y contexto de negocio como `paymentRef`, `agentId`, `chain`, `txHash`, `publicKey`

Alertas recomendadas en Better Stack:

- `event = x402.settle.failed` o `status >= 500`
- `event = x402.settle.passport_denied` para detectar rechazos del gate ZK
- `reason = friendbot_failed` o `reason = horizon_lookup_failed` para incidentes Stellar testnet

---

## Instalación y desarrollo local

```bash
npx create-open-stellar-app my-node
cd my-node
npm install
```

O clonar el repositorio completo:

```bash
git clone https://github.com/bitcoindefi/Open-Stellar.git
cd Open-Stellar
npm install
```

Crear `.env.local`:

```env
NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=tu_project_id
```

Iniciar dev server:

```bash
npm run dev
```

> El script usa `next dev --webpack`. La flag `--webpack` es obligatoria porque snarkjs requiere configuración webpack y Next.js 16 usa Turbopack por defecto, que ignora `next.config.mjs`.

Build de producción:

```bash
npm run build
```

Pruebas de carga:

```bash
k6 run load-tests/x402-settle.js
```

Ver [load-tests/README.md](load-tests/README.md) para los escenarios de x402, orquestación, SSE y heartbeats.

---

## Deploy a Vercel

El repositorio incluye `vercel.json` que fuerza:

```json
{
  "buildCommand": "next build --webpack",
  "installCommand": "npm install",
  "framework": "nextjs"
}
```

Pasos:

1. Fork en GitHub
2. Importar en [vercel.com/new](https://vercel.com/new)
3. Agregar `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` en las variables de entorno del proyecto
4. Deploy — Vercel detecta Next.js y usa el buildCommand del `vercel.json`

O usar el botón de un click al inicio de este README.

---

## CI y protección de PRs

GitHub Actions ejecuta `.github/workflows/ci.yml` en cada push a `main` y en cada pull request:

- `npm ci`
- `npx tsc --noEmit --pretty false`
- `npx vitest run`
- `npm run secretlint -- --format=github`
- `npm run build`
- `npm run size-limit`

El workflow `.github/workflows/preview.yml` deja un comentario en cada PR con la ubicación del preview. Si el repositorio define la variable `VERCEL_PREVIEW_URL`, el comentario enlaza esa URL; si no, indica que el preview lo publica la integración GitHub de Vercel.

Protecciones recomendadas para `main`:

- requerir el check `Typecheck, tests, build, and guards` antes de mergear;
- requerir al menos una revisión en PRs que toquen `lib/protocols/**` o `contracts/**`;
- mantener `Require branches to be up to date before merging` activado para evitar merges sobre una base obsoleta.

---

## SonarCloud Quality Gate

El repositorio está integrado con SonarCloud para análisis estático de código y cobertura de tests. Los badges de calidad se muestran al inicio de este README.

Configuración:

- **Quality Gate**: Se ejecuta en cada push a `main` y en cada PR.
- **Exclusiones**: `scripts/templates/**` está excluido del análisis para evitar falsos positivos en archivos con placeholders intencionales.
- **Cobertura**: Se reporta desde `coverage/lcov.info` generado por Vitest.

Para que el quality gate aparezca como status check en PRs, asegúrate de que la [configuración de SonarCloud](https://sonarcloud.io/project/settings?project=Bitcoindefi_Open-Stellar&id=Bitcoindefi_Open-Stellar) tenga activado:

- **Administration > General Settings > Pull Request** → "Enable pull request decoration"
- **Administration > Quality Gate** → Seleccionar el quality gate por defecto o uno custom

---

## Contratos desplegados (Stellar testnet)

| Contrato               | ID                                                         |
| ---------------------- | ---------------------------------------------------------- |
| AgentPassportValidator | `CDNSZUNEWFCGSPWLPDSWTENR2WPHKC34RGZQG7RJA54OPGTZGVVRFYBA` |
| CircomGroth16Verifier  | `CCMKLYSRUH2HMA4UU6WLXWQXEY6KAH5AWB5BEVMJGNGC5GLGTVROLG4A` |

Explorar en [stellar.expert/explorer/testnet](https://stellar.expert/explorer/testnet).

---

## Estructura de archivos relevantes

```
app/
  api/
    protocol/
      x402/              x402 quote + settle
      passport/          ZK passport authorize + status
      reputation/        motor de reputación
      track8004/         resolución ERC-8004
    stellar/             balance, build-tx, submit-tx, fund

components/
  admin/
    admin-console.tsx    console multi-tab
    passport-panel.tsx   ZK passport UI
  agentic-city/           hub principal
  wallet/                botones y panel de transacción

lib/
  passport/
    passport.ts          pipeline ZK completo
    validator-client.ts  bindings Soroban (stellar-sdk v16)
    snarkjs.d.ts         tipos snarkjs
  protocols/
    x402.ts              x402 quote/settle/registry
    track8004.ts         resolución 8004
  reputation/
    reputation-store.ts  store de reputación

public/zk/               artifacts circom (WASM + zkey + vk)

contracts/
  evm/                   Solidity (EscrowMilestone, X402ServicePaywall)
  stellar/escrow/        Soroban base escrow (Rust)

vercel.json              build config para Vercel
```

---

## Repositorios relacionados

- [open-stellar-passport](https://github.com/bitcoindefi/open-stellar-passport) — fuente original del sistema ZK passport (Vite standalone), portado a este repo en `lib/passport/`

---

## Scripts de deploy de contratos

```bash
npm run deploy:evm:guide     # guía interactiva EVM
npm run deploy:soroban:guide # guía interactiva Soroban
```

---

## Licencia

MIT


## Agent leaderboard (issue #313)

`GET /api/agents-leaderboard?limit=20&metric=xp`

Ranks every registered agent by one of three metrics — `xp`, `quests`
(completed quests), or `districts` (unlocked districts) — with contiguous ranks
starting at 1 and inactive agents ranked (not omitted).

- Cached in-process for 60 s; invalidated automatically when a quest completes
  or XP is awarded, so rankings never go stale after activity.
- `limit` clamps to 1..100.
