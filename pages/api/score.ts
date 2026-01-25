import type { NextApiRequest, NextApiResponse } from "next";
import type {
  ChainAuto,
  ScoreResponse,
  Signal,
  Chain,
  Confidence,
  RiskLevel,
  TopHolder,
  DevHistory
} from "../../lib/types";
import { normalizeChain } from "../../lib/detect";
import { explorerAddress, explorerToken } from "../../lib/explorer";
import { Connection, PublicKey } from "@solana/web3.js";

/* =========================================================
   In-memory cache (serverless-safe, best effort)
   ========================================================= */

type CacheEntry = { ts: number; value: any };

const __PG_CACHE: Map<string, CacheEntry> =
  (globalThis as any).__PG_CACHE || new Map();
(globalThis as any).__PG_CACHE = __PG_CACHE;

function cacheGet(key: string, ttlMs: number) {
  const e = __PG_CACHE.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > ttlMs) {
    __PG_CACHE.delete(key);
    return null;
  }
  return e.value;
}

function cacheSet(key: string, value: any) {
  __PG_CACHE.set(key, { ts: Date.now(), value });
}

/* =========================================================
   Helpers
   ========================================================= */

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function levelFromScore(score: number): RiskLevel {
  if (score >= 70) return "HIGH";
  if (score >= 35) return "MEDIUM";
  return "LOW";
}

/* =========================================================
   Types
   ========================================================= */

type SolTokenMeta = {
  supply_ui?: number;
  age_seconds?: number;
  holders?: number;
  top10_percent?: number;
  dev_candidate?: string;
  mint_authority_present?: boolean;
  freeze_authority_present?: boolean;
  dev_top10_hold_percent?: number;
};

type HeliusTx = {
  signature?: string;
  timestamp?: number;
  tokenTransfers?: Array<{
    mint: string;
    fromUserAccount?: string | null;
    toUserAccount?: string | null;
    tokenAmount?: number | null;
  }>;
};

/* =========================================================
   Helius helpers
   ========================================================= */

async function heliusFetch<T>(path: string): Promise<T> {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) throw new Error("Missing HELIUS_API_KEY");

  const url = `https://api.helius.xyz${path}${
    path.includes("?") ? "&" : "?"
  }api-key=${apiKey}`;

  const resp = await fetch(url, {
    headers: { accept: "application/json" }
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Helius error ${resp.status}: ${txt.slice(0, 200)}`);
  }

  return resp.json() as Promise<T>;
}

/* =========================================================
   Dev detection
   ========================================================= */

async function bestDevCandidate(
  mintAuth: string | null,
  freezeAuth: string | null,
  signerDev?: string | null
): Promise<{ dev?: string; reason: string }> {
  if (mintAuth) return { dev: mintAuth, reason: "mintAuthority" };
  if (freezeAuth) return { dev: freezeAuth, reason: "freezeAuthority" };
  if (signerDev) return { dev: signerDev, reason: "earliestSigner" };
  return { reason: "unknown" };
}

async function detectEarliestSigner(
  conn: Connection,
  mintPk: PublicKey
): Promise<{ signer?: string; proofSig?: string; launchTs?: number }> {
  const sigs = await conn.getSignaturesForAddress(mintPk, { limit: 1000 });
  if (sigs.length === 0) return {};

  const oldest = sigs[sigs.length - 1];
  const sig = oldest.signature;

  let bt = oldest.blockTime ?? null;
  if (!bt && oldest.slot) bt = await conn.getBlockTime(oldest.slot);

  const launchTs = bt ?? undefined;
  const tx = await conn.getParsedTransaction(sig, {
    maxSupportedTransactionVersion: 0
  });

  if (!tx) return { proofSig: sig, launchTs };

  const keys: any[] = (tx.transaction.message as any).accountKeys || [];
  const signer = keys.find(k => k.signer);
  const signerStr =
    signer?.pubkey?.toString?.() || signer?.toString?.();

  return signerStr
    ? { signer: signerStr, proofSig: sig, launchTs }
    : { proofSig: sig, launchTs };
}

/* =========================================================
   Solana token signals
   ========================================================= */

async function solTokenSignals(
  conn: Connection,
  mint: string
): Promise<{ signals: Signal[]; meta: SolTokenMeta; launchTs?: number }> {
  const signals: Signal[] = [];

  // helper: normalize weight/proof to avoid "0 almost всегда" из-за типов/undefined
  const addSignal = (s: Signal) => {
    signals.push({
      ...s,
      weight: Number((s as any).weight) || 0,
      proof: Array.isArray((s as any).proof) ? (s as any).proof : [],
    } as any);
  };

  const meta: SolTokenMeta = {};
  const mintPk = new PublicKey(mint);

  /* ---------- Mint authorities ---------- */

  const mintAcc = await conn.getParsedAccountInfo(mintPk);
  const parsed: any = (mintAcc.value?.data as any)?.parsed;
  const info = parsed?.info || null;

  const mintAuth = info?.mintAuthority ?? null;
  const freezeAuth = info?.freezeAuthority ?? null;

  meta.mint_authority_present = Boolean(mintAuth);
  meta.freeze_authority_present = Boolean(freezeAuth);

  if (mintAuth) {
    addSignal({
      id: "MINT_AUTHORITY_PRESENT",
      label: "Mint authority is still present (supply can be increased)",
      value: mintAuth,
      weight: 10,
      proof: [explorerToken("sol", mint)],
    } as any);
  }

  if (freezeAuth) {
    addSignal({
      id: "FREEZE_AUTHORITY_PRESENT",
      label: "Freeze authority is present (accounts can be frozen)",
      value: freezeAuth,
      weight: 6,
      proof: [explorerToken("sol", mint)],
    } as any);
  }


  /* ---------- Supply & holders ---------- */

const supply = await conn.getTokenSupply(mintPk);
const supplyUi = supply.value.uiAmount ?? null;
meta.supply_ui = supplyUi ?? undefined;

const largest = await conn.getTokenLargestAccounts(mintPk);
const top = largest.value.slice(0, 10);

let topSum = 0;
for (const a of top) topSum += a.uiAmount ?? 0;

const top10Percent =
  supplyUi && supplyUi > 0 ? (topSum / supplyUi) * 100 : undefined;

meta.top10_percent = top10Percent;
meta.holders = largest.value.length;

if (typeof top10Percent === "number") {
  if (top10Percent > 80) {
    addSignal({
      id: "TOP10_GT_80",
      label: "Top holders concentration is extreme",
      value: `top10=${top10Percent.toFixed(1)}%`,
      weight: 18,
      proof: [explorerToken("sol", mint)],
    } as any);
  } else if (top10Percent > 60) {
    addSignal({
      id: "TOP10_GT_60",
      label: "Top holders concentration is high",
      value: `top10=${top10Percent.toFixed(1)}%`,
      weight: 10,
      proof: [explorerToken("sol", mint)],
    } as any);
  }
}

 /* ---------- Age ---------- */

try {
  // RPC часто ограничивает/тормозит большие лимиты — 200 достаточно для "очень новый"
  const sigs = await conn.getSignaturesForAddress(mintPk, { limit: 200 });

  if (sigs.length > 0) {
    const oldest = sigs[sigs.length - 1];
    let bt = oldest.blockTime ?? null;

    // На некоторых RPC blockTime может быть null — пробуем достать через slot
    if (!bt && oldest.slot) {
      bt = await conn.getBlockTime(oldest.slot);
    }

    if (bt) {
      const now = Math.floor(Date.now() / 1000);
      const ageSeconds = Math.max(0, now - bt);
      meta.age_seconds = ageSeconds;

      // < 1h
      if (ageSeconds < 3600) {
        addSignal({
          id: "TOKEN_AGE_LT_1H",
          label: "Token is very new (<1h)",
          value: `${Math.max(1, Math.floor(ageSeconds / 60))}m`,
          weight: 8,
          proof: [explorerToken("sol", mint)],
        } as any);

        // 1–6h
      } else if (ageSeconds < 21600) {
        addSignal({
          id: "TOKEN_AGE_LT_6H",
          label: "Token is new (1–6h)",
          value: `${Math.floor(ageSeconds / 3600)}h`,
          weight: 4,
          proof: [explorerToken("sol", mint)],
        } as any);

        // 6–24h (чтобы CONTEXT не был нулём почти всегда)
      } else if (ageSeconds < 86400) {
        addSignal({
          id: "TOKEN_AGE_LT_24H",
          label: "Token is fresh (6–24h)",
          value: `${Math.floor(ageSeconds / 3600)}h`,
          weight: 2,
          proof: [explorerToken("sol", mint)],
        } as any);
      }
    }
  }
} catch (e) {
  // молча игнорируем: age — не критичный сигнал, RPC может ограничивать запросы
}

 /* ---------- Dev candidate ---------- */

let signerDev: string | null = null;
let proofSig: string | undefined;
let launchTs: number | undefined;

try {
  const r = await detectEarliestSigner(conn, mintPk);
  signerDev = r.signer ?? null;
  proofSig = r.proofSig;
  launchTs = r.launchTs;
} catch {}

const { dev, reason } = await bestDevCandidate(mintAuth, freezeAuth, signerDev);

// helper: proof url
const devProof = proofSig
  ? [`https://solscan.io/tx/${proofSig}`]
  : [explorerToken("sol", mint)];

if (dev) {
  meta.dev_candidate = dev;

  // веса: чем слабее источник — тем ниже вес
  const w =
    reason === "earliestSigner" ? 12 :
    reason === "mintAuthority" ? 8 :
    reason === "freezeAuthority" ? 6 :
    4; // fallback

  // IMPORTANT: id должен начинаться с DEV_CANDIDATE чтобы попасть в CONTEXT в твоём categorizeSignalId
  signals.push({
    id: "DEV_CANDIDATE",
    label: `Dev wallet candidate (${reason})`,
    value: dev,
    weight: w,
    proof: devProof,
  });

  // Доп. сигнал (dev behavior), если нашли earliest signer
  if (reason === "earliestSigner" && signerDev) {
    signals.push({
      id: "DEV_EARLY_SIGNER",
      label: "Dev was earliest signer (possible deployer/initiator)",
      value: signerDev,
      weight: 6,
      proof: devProof,
    });
  }
} else {
  // Чтобы UI/логика не были “пустыми”, если дев не найден
  meta.dev_candidate = undefined;
  signals.push({
    id: "DEV_UNKNOWN",
    label: "Dev wallet candidate not found",
    value: "",
    weight: 2,
    proof: [explorerToken("sol", mint)],
  });
}

return { signals, meta, launchTs };
}

/* =========================================================
   API handler
   ========================================================= */

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ScoreResponse | any>
) {
  const ttlMs = 120_000;
  const cacheKey = `score:${req.url || ""}`;

  const cached = cacheGet(cacheKey, ttlMs);
  if (cached) {
    res.setHeader("x-pg-cache", "HIT");
    return res.status(200).json(cached);
  }

  if (req.method !== "GET")
    return res.status(405).json({ error: "Method not allowed" });

  const input = (req.query.input as string || "").trim();
  if (!input) return res.status(400).json({ error: "Missing input" });

  const chain = normalizeChain(
    (req.query.chain as ChainAuto) || "auto",
    input
  );

  let signals: Signal[] = [];
  let score = 10;
  let confidence: Confidence = "LOW";
  let mode: "LIVE" | "DEMO" = "DEMO";

  try {
    if (chain === "sol") {
      const rpc =
        process.env.SOLANA_RPC_URL ||
        "https://api.mainnet-beta.solana.com";
      const conn = new Connection(rpc, "confirmed");

      mode = "LIVE";
      confidence = "MED";

      const r = await solTokenSignals(conn, input);
      signals.push(...r.signals);

      for (const s of signals) score += s.weight;
      score = clamp(score, 0, 100);

      if (
        r.meta.age_seconds &&
        r.meta.top10_percent &&
        r.meta.dev_candidate &&
        process.env.HELIUS_API_KEY
      ) {
        confidence = "HIGH";
      }

      const response: ScoreResponse = {
        chain,
        input_type: "token",
        token: {
          address: input,
          age_seconds: r.meta.age_seconds,
          holders: r.meta.holders,
          top10_percent: r.meta.top10_percent,
          links: { explorer: explorerToken("sol", input) }
        },
        dev: r.meta.dev_candidate
          ? {
              address: r.meta.dev_candidate,
              links: {
                explorer: explorerAddress("sol", r.meta.dev_candidate)
              }
            }
          : undefined,
        risk: {
          score,
          level: levelFromScore(score),
          confidence,
          mode
        },
        signals,
        community: { rugged: 0, sus: 0, trusted: 0, recent: [] }
      };

      cacheSet(cacheKey, response);
      return res.status(200).json(response);
    }
  } catch (e: any) {
    signals.push({
      id: "LIVE_ERROR",
      label: "Live scoring failed, falling back to demo",
      value: String(e?.message || e),
      weight: 0
    });
  }

  /* ---------- DEMO fallback ---------- */

  signals.push({
    id: "DEMO_MODE",
    label: "Demo mode (missing RPC or API keys)",
    weight: 0
  });

  const response: ScoreResponse = {
    chain: chain as Chain,
    input_type: "token",
    risk: {
      score: clamp(score, 0, 100),
      level: levelFromScore(score),
      confidence,
      mode
    },
    signals,
    community: { rugged: 0, sus: 0, trusted: 0, recent: [] }
  };

  cacheSet(cacheKey, response);
  return res.status(200).json(response);
}
