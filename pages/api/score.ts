import type { NextApiRequest, NextApiResponse } from "next";
import type {
  ChainAuto,
  ScoreResponse,
  Signal,
  Chain,
  Confidence,
  RiskLevel
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

/**
 * Risk model (caps):
 * PERMISSIONS        max 10
 * DISTRIBUTION       max 30
 * LIQUIDITY (LP)     max 10
 * DEV / CONTRACT     max 30
 * TX PATTERNS        max 20
 * CONTEXT            0 (info only)
 */
type RiskCategory =
  | "PERMISSIONS"
  | "DISTRIBUTION"
  | "LIQUIDITY"
  | "DEV_CONTRACT"
  | "TX_PATTERNS"
  | "CONTEXT";

const CATEGORY_MAX: Record<RiskCategory, number> = {
  PERMISSIONS: 10,
  DISTRIBUTION: 30,
  LIQUIDITY: 10,
  DEV_CONTRACT: 30,
  TX_PATTERNS: 20,
  CONTEXT: 0
};

function categorizeSignalId(id: string): RiskCategory {
  // PERMISSIONS
  if (id === "MINT_AUTHORITY_PRESENT" || id === "FREEZE_AUTHORITY_PRESENT")
    return "PERMISSIONS";

  // DISTRIBUTION
  if (id.startsWith("TOP10_") || id.startsWith("DEV_HOLDS_"))
    return "DISTRIBUTION";

  // LIQUIDITY
  if (id.startsWith("LP_")) return "LIQUIDITY";

  // DEV / CONTRACT
  if (
    id.startsWith("BLACKLIST_") ||
    id.startsWith("TAX_") ||
    id.startsWith("TRANSFER_") ||
    id.startsWith("HOOKS_") ||
    id.startsWith("NONSTANDARD_")
  )
    return "DEV_CONTRACT";

  // TX PATTERNS
  if (
    id.startsWith("DEV_DUMP_") ||
    id.startsWith("BUNDLED_") ||
    id.startsWith("MEV_") ||
    id.startsWith("CLUSTER_")
  )
    return "TX_PATTERNS";

  // CONTEXT (info only)
  if (
    id.startsWith("TOKEN_AGE_") ||
    id.startsWith("DEV_") || // DEV_CANDIDATE / DEV_UNKNOWN / DEV_EARLY_SIGNER etc
    id.startsWith("CONTEXT_")
  )
    return "CONTEXT";

  // fallback: treat unknown as CONTEXT (won't affect score)
  return "CONTEXT";
}

/** Apply category caps to signal weights (keeps your UI "signals" list intact) */
function computeScoreWithCaps(signals: Signal[]) {
  const totals: Record<RiskCategory, number> = {
    PERMISSIONS: 0,
    DISTRIBUTION: 0,
    LIQUIDITY: 0,
    DEV_CONTRACT: 0,
    TX_PATTERNS: 0,
    CONTEXT: 0
  };

  for (const s of signals) {
    const cat = categorizeSignalId(String((s as any).id || ""));
    const w = Number((s as any).weight) || 0;
    totals[cat] += w;
  }

  // cap each category
  let score = 0;
  (Object.keys(totals) as RiskCategory[]).forEach(cat => {
    const capped = clamp(totals[cat], 0, CATEGORY_MAX[cat]);
    score += capped;
  });

  return clamp(score, 0, 100);
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
  const signerStr = signer?.pubkey?.toString?.() || signer?.toString?.();

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

  // helper: normalize proof
  const addSignal = (s: Signal) => {
    signals.push({
      ...s,
      weight: Number((s as any).weight) || 0,
      proof: Array.isArray((s as any).proof) ? (s as any).proof : []
    } as any);
  };

  const meta: SolTokenMeta = {};
  const mintPk = new PublicKey(mint);

  /* ---------- Mint authorities (PERMISSIONS max 10) ---------- */

  const mintAcc = await conn.getParsedAccountInfo(mintPk);
  const parsed: any = (mintAcc.value?.data as any)?.parsed;
  const info = parsed?.info || null;

  const mintAuth = info?.mintAuthority ?? null;
  const freezeAuth = info?.freezeAuthority ?? null;

  meta.mint_authority_present = Boolean(mintAuth);
  meta.freeze_authority_present = Boolean(freezeAuth);

  // NEW MODEL: mint +5, freeze +5
  if (mintAuth) {
    addSignal({
      id: "MINT_AUTHORITY_PRESENT",
      label: "Mint authority is still present (supply can be increased)",
      value: mintAuth,
      weight: 5,
      proof: [explorerToken("sol", mint)]
    } as any);
  }

  if (freezeAuth) {
    addSignal({
      id: "FREEZE_AUTHORITY_PRESENT",
      label: "Freeze authority is present (accounts can be frozen)",
      value: freezeAuth,
      weight: 5,
      proof: [explorerToken("sol", mint)]
    } as any);
  }

  /* ---------- Supply & holders (DISTRIBUTION max 30) ---------- */

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

  // NEW MODEL: 80% -> +15, 60% -> +10, 40% -> +5 (mutually exclusive)
  if (typeof top10Percent === "number") {
    if (top10Percent > 80) {
      addSignal({
        id: "TOP10_GT_80",
        label: "Top holders concentration is extreme",
        value: `top10=${top10Percent.toFixed(1)}%`,
        weight: 15,
        proof: [explorerToken("sol", mint)]
      } as any);
    } else if (top10Percent > 60) {
      addSignal({
        id: "TOP10_GT_60",
        label: "Top holders concentration is high",
        value: `top10=${top10Percent.toFixed(1)}%`,
        weight: 10,
        proof: [explorerToken("sol", mint)]
      } as any);
    } else if (top10Percent > 40) {
      addSignal({
        id: "TOP10_GT_40",
        label: "Top holders concentration is elevated",
        value: `top10=${top10Percent.toFixed(1)}%`,
        weight: 5,
        proof: [explorerToken("sol", mint)]
      } as any);
    }
  }

  /* ---------- LP (LIQUIDITY max 10) ---------- */
  // Variant A: unknown -> 0 points, but show info in WHY
  // Real LP detection (Raydium/Orca/Meteora) will later add:
  // - LP_NOT_BURNED -> +10
  // - LP_BURNED_LOCKED_100 -> +0 (optional info)
  addSignal({
    id: "LP_STATUS_UNKNOWN",
    label: "LP status unknown (not detected yet)",
    value: "",
    weight: 0,
    proof: [explorerToken("sol", mint)]
  } as any);

  /* ---------- Age (CONTEXT only, weight 0) ---------- */

  try {
    const sigs = await conn.getSignaturesForAddress(mintPk, { limit: 200 });
    if (sigs.length > 0) {
      const oldest = sigs[sigs.length - 1];
      let bt = oldest.blockTime ?? null;
      if (!bt && oldest.slot) bt = await conn.getBlockTime(oldest.slot);

      if (bt) {
        const now = Math.floor(Date.now() / 1000);
        const ageSeconds = Math.max(0, now - bt);
        meta.age_seconds = ageSeconds;

        if (ageSeconds < 3600) {
          addSignal({
            id: "TOKEN_AGE_LT_1H",
            label: "Token is very new (<1h)",
            value: `${Math.max(1, Math.floor(ageSeconds / 60))}m`,
            weight: 0,
            proof: [explorerToken("sol", mint)]
          } as any);
        } else if (ageSeconds < 21600) {
          addSignal({
            id: "TOKEN_AGE_LT_6H",
            label: "Token is new (1–6h)",
            value: `${Math.floor(ageSeconds / 3600)}h`,
            weight: 0,
            proof: [explorerToken("sol", mint)]
          } as any);
        } else if (ageSeconds < 86400) {
          addSignal({
            id: "TOKEN_AGE_LT_24H",
            label: "Token is fresh (6–24h)",
            value: `${Math.floor(ageSeconds / 3600)}h`,
            weight: 0,
            proof: [explorerToken("sol", mint)]
          } as any);
        }
      }
    }
  } catch {
    // age is context only; ignore RPC errors
  }

  /* ---------- Dev candidate (CONTEXT only, weight 0) ---------- */

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

  const devProof = proofSig
    ? [`https://solscan.io/tx/${proofSig}`]
    : [explorerToken("sol", mint)];

  if (dev) {
    meta.dev_candidate = dev;

    addSignal({
      id: "DEV_CANDIDATE",
      label: `Dev wallet candidate (${reason})`,
      value: dev,
      weight: 0, // CONTEXT ONLY
      proof: devProof
    } as any);

    if (reason === "earliestSigner" && signerDev) {
      addSignal({
        id: "DEV_EARLY_SIGNER",
        label: "Dev was earliest signer (possible deployer/initiator)",
        value: signerDev,
        weight: 0, // CONTEXT ONLY
        proof: devProof
      } as any);
    }
  } else {
    meta.dev_candidate = undefined;
    addSignal({
      id: "DEV_UNKNOWN",
      label: "Dev wallet candidate not found",
      value: "",
      weight: 0, // CONTEXT ONLY
      proof: [explorerToken("sol", mint)]
    } as any);
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

  const input = ((req.query.input as string) || "").trim();
  if (!input) return res.status(400).json({ error: "Missing input" });

  const chain = normalizeChain((req.query.chain as ChainAuto) || "auto", input);

  let signals: Signal[] = [];
  let score = 0; // NEW: no base points
  let confidence: Confidence = "LOW";
  let mode: "LIVE" | "DEMO" = "DEMO";

  try {
    if (chain === "sol") {
      const rpc =
        process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
      const conn = new Connection(rpc, "confirmed");

      mode = "LIVE";
      confidence = "MED";

      const r = await solTokenSignals(conn, input);
      signals.push(...r.signals);

      // NEW: compute using category caps (CONTEXT=0)
      score = computeScoreWithCaps(signals);

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
              links: { explorer: explorerAddress("sol", r.meta.dev_candidate) }
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
    } as any);
  }

  /* ---------- DEMO fallback ---------- */

  signals.push({
    id: "DEMO_MODE",
    label: "Demo mode (missing RPC or API keys)",
    weight: 0
  } as any);

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
