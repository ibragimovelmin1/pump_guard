# PUMP.GUARD MVP (SOL + ETH + BNB)

A minimal working scaffold (single Next.js app: UI + API).
- Scoring API: `/api/score`
- Community flags (optional): Supabase

## Run locally
```bash
npm install
npm run dev
```
Open http://localhost:3000

## Optional env (.env.local)
```bash
HELIUS_API_KEY=YOUR_KEY
COVALENT_API_KEY=YOUR_KEY
SUPABASE_URL=YOUR_URL
SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVICE_ROLE_KEY
FP_SALT=any_random_string
```
Without keys, the app runs in DEMO mode.

## Supabase table
```sql
create table if not exists flags (
  id uuid primary key default gen_random_uuid(),
  chain text not null,
  target_type text not null,
  target_address text not null,
  flag_type text not null,
  reason text,
  fingerprint_hash text,
  created_at timestamptz not null default now()
);
create index if not exists flags_target_idx on flags(chain, target_type, target_address);
create index if not exists flags_created_idx on flags(created_at);
```


### Solana RPC
Set `SOLANA_RPC_URL` (recommended: Helius RPC URL). If not set, falls back to public mainnet-beta RPC.

Example:
```bash
SOLANA_RPC_URL=https://rpc.helius.xyz/?api-key=YOUR_KEY
```


## SOL v0.3: Early-dump heuristic (Helius)
Set `HELIUS_API_KEY` to enable early-dump signals (dev candidate outgoing transfers in first 60 minutes).


## Shareable report links
After checking a token, open: `/r/<chain>/<tokenAddress>` (e.g. `/r/sol/<mint>`) and share it.


### Wallet reports
Open: `/r/<chain>/<wallet>?type=wallet` to generate a shareable wallet report.


## v0.8
Report pages include Community flags (vote + counts + recent). Requires Supabase env vars.


## v0.9.1
Developer history enhanced: died<24h heuristic, median first outgoing transfer time, suspected rugs heuristic.


## v0.9.2
Dev history improved: better launch timestamp fallback, checks up to 8 mints, smarter died<24h heuristic, adds one-line summary in report.


## v0.10
Top holders upgraded with concentration heat + Share summary button on report.


## v0.11
Top holders tagging improved: off-curve PDA owners are tagged as LP (heuristic). Report shows a Risk warning when dev is a top holder or concentration is HIGH.


## v0.12
Top holders show LP confidence: LP tagged via PDA shows as `LP (PDA)` in report. Added signals: LP_OWNER_IN_TOP_HOLDERS (informational) and DEV_IN_TOP_HOLDERS_WARNING (informational).


## v0.13
Early buyers detection (heuristic): uses Helius mint txs in first 10 minutes to tag top holders as EARLY and adds signal EARLY_SNIPERS_IN_TOP_HOLDERS.


## v0.14
Sniper cluster heuristics: estimates supply controlled by EARLY holders and detects shared funder among EARLY wallets (Helius native transfers). Adds signals EARLY_HOLDERS_CONTROL_SUPPLY and SNIPER_CLUSTER_SHARED_FUNDER.


## v0.15
Release prep: Report quick summary (one-line), Top holders shows Early% and sniper funder hint, clearer disclaimers.


## v0.16
Stability pack: in-memory cache (60s), basic IP rate-limit, degraded mode UI when providers fail.
