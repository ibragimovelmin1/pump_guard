import type { NextApiRequest, NextApiResponse } from "next";
import type {
  ChainAuto,
  ScoreResponse,
  Signal,
  Chain,
  Confidence,
  RiskLevel,
} from "../../lib/types";
import { normalizeChain } from "../../lib/detect";
import { explorerAddress, explorerToken } from "../../lib/explorer";
import { Connection, PublicKey } from "@solana/web3.js";

/* =========================================================
   In-memory cache
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
  CONTEXT: 0,
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
    id.startsWith("NONSTANDARD_") ||
    id === "HIGH_TAX" ||
    id === "BLACKLIST_OR_TRANSFER_BLOCK" ||
    id === "NONSTANDARD_TRANSFER"
  )
    return "DEV_CONTRACT";

  // TX PATTERNS
  if (
    id.startsWith("DEV_DUMP_") ||
    id.startsWith("BUNDLED_") ||
    id.startsWith("MEV_") ||
    id.startsWith("CLUSTER_") ||
    id === "DEV_DUMP_EARLY" ||
    id === "BUNDLED_LAUNCH_OR_MEV" ||
    id === "CLUSTER_FUNDING"
  )
    return "TX_PATTERNS";

  // CONTEXT
  if (id.startsWith("DEV_") || id.startsWith("CONTEXT_")) return "CONTEXT";

  return "CONTEXT";
}

function computeScoreWithCaps(signals: Signal[]) {
  const totals: Record<RiskCategory, number> = {
    PERMISSIONS: 0,
    DISTRIBUTION: 0,
    LIQUIDITY: 0,
    DEV_CONTRACT: 0,
    TX_PATTERNS: 0,
    CONTEXT: 0,
  };

  for (const s of signals) {
    const cat = categorizeSignalId(String((s as any).id || ""));
    const w = Number((s as any).weight) || 0;
    totals[cat] += w;
  }

  let score = 0;
  (Object.keys(totals) as RiskCategory[]).forEach((cat) => {
    score += clamp(totals[cat], 0, CATEGORY_MAX[cat]);
  });

  return clamp(score, 0, 100);
}

/* =========================================================
   Proof links + safe wrappers (do not break existing proof: string[])
   ========================================================= */

function withTimeout<T>(p: Promise<T>, ms = 5000) {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then((v) => {
      clearTimeout(t);
      resolve(v);
    }).catch((e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}

function toProofLinks(urls: string[] | undefined) {
  const arr = Array.isArray(urls) ? urls : [];
  return arr.map((url) => {
    let label = "Proof";
    if (url.includes("solscan.io")) label = "Solscan";
    else if (url.includes("solana.fm")) label = "SolanaFM";
    else if (url.includes("birdeye.so")) label = "Birdeye";
    return { label, url };
  });
}

/** Adds proofLinks without breaking current UI that expects proof: string[] */
function decorateSignals(signals: Signal[]) {
  return signals.map((s: any) => {
    const proof = Array.isArray(s.proof) ? s.proof : [];
    return {
      ...s,
      proof,
      proofLinks: toProofLinks(proof),
    };
  });
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

/* =========================================================
   Helius RPC helper (single source of truth)
   ========================================================= */

async function heliusRpc<T>(body: any): Promise<T> {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) throw new Error("Missing HELIUS_API_KEY");

  // ✅ correct domain is api-mainnet.helius-rpc.com (dash, not dot)
  const url = `https://api-mainnet.helius-rpc.com/?api-key=${apiKey}`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Helius RPC error ${resp.status}: ${txt.slice(0, 200)}`);
  }

  const j = await resp.json();
  if (j?.error) throw new Error(j.error?.message || "Helius RPC returned error");
  return j?.result as T;
}

async function getTokenNameSymbolHelius(
  mint: string
): Promise<{ name?: string; symbol?: string }> {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) return {};

  // 1) Helius Token Metadata (лучше всего для SPL)
  try {
    const url = `https://api.helius.xyz/v0/token-metadata?api-key=${apiKey}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mintAccounts: [mint] }),
    });

    if (resp.ok) {
      const arr = (await resp.json()) as any[];
      const t = arr?.[0];

      const name =
        t?.onChainMetadata?.metadata?.data?.name ||
        t?.offChainMetadata?.metadata?.name;

      const symbol =
        t?.onChainMetadata?.metadata?.data?.symbol ||
        t?.offChainMetadata?.metadata?.symbol;

      if (name || symbol) return { name, symbol };
    }
  } catch {
    // ignore
  }

  // 2) Fallback: DAS getAsset (как запасной вариант)
  try {
    const asset = await heliusRpc<any>({
      jsonrpc: "2.0",
      id: "get-asset",
      method: "getAsset",
      params: { id: mint },
    });

    const name =
      asset?.content?.metadata?.name ??
      asset?.metadata?.name ??
      asset?.token_info?.name;

    const symbol =
      asset?.content?.metadata?.symbol ??
      asset?.token_info?.symbol ??
      asset?.metadata?.symbol;

    return { name, symbol };
  } catch {
    return {};
  }
}

/* =========================================================
   Holders count (real) via Helius DAS getTokenAccounts
   ========================================================= */

async function getHoldersCountHelius(mint: string): Promise<number | undefined> {
  if (!process.env.HELIUS_API_KEY) return undefined;

  type Resp = {
    token_accounts?: Array<{ owner?: string; amount?: number }>;
    cursor?: string;
  };

  const owners = new Set<string>();
  let cursor: string | undefined = undefined;

  const LIMIT = 1000;
  const MAX_PAGES = 25;
  const MAX_OWNERS = 50_000;

  for (let i = 0; i < MAX_PAGES; i++) {
    const page: Resp = await heliusRpc<Resp>({
      jsonrpc: "2.0",
      id: `get-token-accounts-${i}`,
      method: "getTokenAccounts",
      params: {
        mint,
        limit: LIMIT,
        cursor,
      },
    });

    const arr = page?.token_accounts ?? [];
    for (const ta of arr) {
      if (ta?.owner && (ta.amount ?? 0) > 0) owners.add(ta.owner);
      if (owners.size >= MAX_OWNERS) return owners.size;
    }

    if (!page?.cursor || arr.length === 0) break;
    cursor = page.cursor;
  }

  return owners.size || undefined;
}

/* =========================================================
   Age: Helius (fast + deeper history) with fallback
   ========================================================= */

async function getLaunchTsHelius(address: string): Promise<number | undefined> {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) return undefined;

  // Enhanced Transactions by Address (asc = oldest first)
  const url =
    `https://api-mainnet.helius-rpc.com/v0/addresses/${address}/transactions` +
    `?api-key=${apiKey}&limit=1&sort-order=asc`;

  const resp = await fetch(url, { headers: { accept: "application/json" } });
  if (!resp.ok) return undefined;

  const txs = (await resp.json()) as Array<{ timestamp?: number }>;
  const ts = txs?.[0]?.timestamp;
  return typeof ts === "number" ? ts : undefined;
}

async function getTokenAgeSecondsFallback(conn: Connection, mintPk: PublicKey) {
  const now = Math.floor(Date.now() / 1000);
  let before: string | undefined = undefined;
  let oldestBt: number | null = null;

  const MAX_PAGES = 8; // keep it fast
  for (let page = 0; page < MAX_PAGES; page++) {
    const sigs = await conn.getSignaturesForAddress(mintPk, {
      limit: 1000,
      before,
    });
    if (sigs.length === 0) break;

    const last = sigs[sigs.length - 1];
    before = last.signature;

    let bt = last.blockTime ?? null;
    if (!bt && last.slot) bt = await conn.getBlockTime(last.slot);
    if (bt) oldestBt = bt;

    if (sigs.length < 1000) break;
  }

  if (!oldestBt) return undefined;
  return Math.max(0, now - oldestBt);
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
    maxSupportedTransactionVersion: 0,
  });

  if (!tx) return { proofSig: sig, launchTs };

  const keys: any[] = (tx.transaction.message as any).accountKeys || [];
  const signer = keys.find((k) => k.signer);
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
): Promise<{ signals: Signal[]; meta: SolTokenMeta }> {
  const signals: Signal[] = [];
  const addSignal = (s: Signal) => {
    signals.push({
      ...s,
      weight: Number((s as any).weight) || 0,
      proof: Array.isArray((s as any).proof) ? (s as any).proof : [],
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

  if (mintAuth) {
    addSignal({
      id: "MINT_AUTHORITY_PRESENT",
      label: "Mint authority is still present (supply can be increased)",
      value: mintAuth,
      weight: 5,
      proof: [explorerToken("sol", mint)],
    } as any);
  }

  if (freezeAuth) {
    addSignal({
      id: "FREEZE_AUTHORITY_PRESENT",
      label: "Freeze authority is present (accounts can be frozen)",
      value: freezeAuth,
      weight: 5,
      proof: [explorerToken("sol", mint)],
    } as any);
  }

  /* ---------- Supply & top10 (DISTRIBUTION max 30) ---------- */

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

  // IMPORTANT: do NOT treat largest accounts count as holders count
  meta.holders = undefined;

  if (typeof top10Percent === "number") {
    if (top10Percent > 80) {
      addSignal({
        id: "TOP10_GT_80",
        label: "Top holders concentration is extreme",
        value: `top10=${top10Percent.toFixed(1)}%`,
        weight: 15,
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
    } else if (top10Percent > 40) {
      addSignal({
        id: "TOP10_GT_40",
        label: "Top holders concentration is elevated",
        value: `top10=${top10Percent.toFixed(1)}%`,
        weight: 5,
        proof: [explorerToken("sol", mint)],
      } as any);
    }
  }

  /* ---------- LP (info only) ---------- */
  addSignal({
    id: "LP_STATUS_UNKNOWN",
    label: "LP status unknown (not detected yet)",
    value: "",
    weight: 0,
    proof: [explorerToken("sol", mint)],
  } as any);

  /* ---------- Age (META only) ---------- */
  try {
    const ts = await getLaunchTsHelius(mint);
    if (ts) {
      const now = Math.floor(Date.now() / 1000);
      meta.age_seconds = Math.max(0, now - ts);
    } else {
      meta.age_seconds = await getTokenAgeSecondsFallback(conn, mintPk);
    }
  } catch {
    // ignore
  }

  /* ---------- Dev candidate (CONTEXT only, weight 0) ---------- */

  let signerDev: string | null = null;
  let proofSig: string | undefined;

  try {
    const r = await detectEarliestSigner(conn, mintPk);
    signerDev = r.signer ?? null;
    proofSig = r.proofSig;
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
      weight: 0,
      proof: devProof,
    } as any);

    if (reason === "earliestSigner" && signerDev) {
      addSignal({
        id: "DEV_EARLY_SIGNER",
        label: "Dev was earliest signer (possible deployer/initiator)",
        value: signerDev,
        weight: 0,
        proof: devProof,
      } as any);
    }
  } else {
    meta.dev_candidate = undefined;
    addSignal({
      id: "DEV_UNKNOWN",
      label: "Dev wallet candidate not found",
      value: "",
      weight: 0,
      proof: [explorerToken("sol", mint)],
    } as any);
  }

  /* ---------- Dev holds (DISTRIBUTION, dynamic) ---------- */
  // UI ждёт: DEV_HOLDS_GT_30 / DEV_HOLDS_GT_50

  const devAddr = meta.dev_candidate;
  const supplyUiNum =
    typeof meta.supply_ui === "number" ? meta.supply_ui : undefined;

  if (devAddr && supplyUiNum && supplyUiNum > 0) {
    try {
      const devPk = new PublicKey(devAddr);

      const devAccounts = await conn.getParsedTokenAccountsByOwner(devPk, {
        mint: mintPk,
      });

      let devAmountUi = 0;
      for (const acc of devAccounts.value as any[]) {
        const ui = acc?.account?.data?.parsed?.info?.tokenAmount?.uiAmount;
        if (typeof ui === "number") devAmountUi += ui;
      }

      const devPct = (devAmountUi / supplyUiNum) * 100;

      if (devPct > 50) {
        addSignal({
          id: "DEV_HOLDS_GT_50",
          label: "Dev wallet holds a very large share of supply",
          value: `dev=${devPct.toFixed(1)}%`,
          weight: 15,
          proof: [explorerAddress("sol", devAddr), explorerToken("sol", mint)],
        } as any);
      } else if (devPct > 30) {
        addSignal({
          id: "DEV_HOLDS_GT_30",
          label: "Dev wallet holds a large share of supply",
          value: `dev=${devPct.toFixed(1)}%`,
          weight: 10,
          proof: [explorerAddress("sol", devAddr), explorerToken("sol", mint)],
        } as any);
      }
    } catch {
      // ignore
    }
  }

  return { signals, meta };
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
  let score = 0;
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
      signals = r.signals;

      // Fetch meta + holders safely (never fail scoring/UI due to these)
      const [tmetaRes, holdersRes] = await Promise.allSettled([
        withTimeout(getTokenNameSymbolHelius(input), 4500),
        withTimeout(getHoldersCountHelius(input), 6500),
      ]);

      const tmeta =
        tmetaRes.status === "fulfilled" && tmetaRes.value ? tmetaRes.value : {};

      const holdersCount =
        holdersRes.status === "fulfilled" &&
        typeof holdersRes.value === "number"
          ? holdersRes.value
          : undefined;

      // score does not depend on holders/meta
      score = computeScoreWithCaps(signals);

      // Confidence v1 (честная)
      confidence = "MED";

      if (mode !== "LIVE") {
        confidence = "LOW";
      } else if (!r.meta.age_seconds || r.meta.age_seconds < 86400) {
        // токену меньше 1 дня → доверие низкое
        confidence = "LOW";
      } else if (
        r.meta.age_seconds &&
        typeof r.meta.top10_percent === "number" &&
        r.meta.dev_candidate &&
        process.env.HELIUS_API_KEY
      ) {
        confidence = "HIGH";
      }

      // IMPORTANT: always send holders as number|null (not undefined)
      const holdersFinal: number | undefined =
      typeof holdersCount === "number" ? holdersCount : undefined;

      const response: ScoreResponse = {
        chain,
        input_type: "token",
        token: {
          address: input,
          name: (tmeta as any)?.name,
          symbol: (tmeta as any)?.symbol,
          age_seconds: r.meta.age_seconds,
          holders: holdersFinal,
          top10_percent: r.meta.top10_percent,
          links: { explorer: explorerToken("sol", input) },
        },
        dev: r.meta.dev_candidate
          ? {
              address: r.meta.dev_candidate,
              links: { explorer: explorerAddress("sol", r.meta.dev_candidate) },
            }
          : undefined,
        risk: {
          score,
          level: levelFromScore(score),
          confidence,
          mode,
        },
        signals: decorateSignals(signals) as any,
        community: { rugged: 0, sus: 0, trusted: 0, recent: [] },
      };

      cacheSet(cacheKey, response);
      return res.status(200).json(response);
    }
  } catch (e: any) {
    signals.push({
      id: "LIVE_ERROR",
      label: "Live scoring failed, falling back to demo",
      value: String(e?.message || e),
      weight: 0,
      proof: [],
    } as any);
  }

  // DEMO fallback
  signals.push({
    id: "DEMO_MODE",
    label: "Demo mode (missing RPC or API keys)",
    weight: 0,
    proof: [],
  } as any);

  const response: ScoreResponse = {
    chain: chain as Chain,
    input_type: "token",
    token: {
      address: input,
      holders: undefined,
      links: chain === "sol" ? { explorer: explorerToken("sol", input) } : undefined,
    } as any,
    risk: {
      score: clamp(score, 0, 100),
      level: levelFromScore(score),
      confidence,
      mode,
    },
    signals: decorateSignals(signals) as any,
    community: { rugged: 0, sus: 0, trusted: 0, recent: [] },
  };

  cacheSet(cacheKey, response);
  return res.status(200).json(response);
}
