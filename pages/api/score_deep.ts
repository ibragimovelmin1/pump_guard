// pages/api/score_deep.ts
import type { NextApiRequest, NextApiResponse } from "next";
import type { Signal } from "../../lib/types";
import { Connection, PublicKey } from "@solana/web3.js";
import { explorerAddress, explorerToken } from "../../lib/explorer";
import { discoverTopPairViaDexScreener } from "../../lib/dexscreener";

/* =========================================================
   In-memory cache (shared global map)
   ========================================================= */

type CacheEntry = { ts: number; value: any };

const __PG_CACHE: Map<string, CacheEntry> = (globalThis as any).__PG_CACHE || new Map();
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

function withTimeout<T>(p: Promise<T>, ms = 12_000) {
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

function uniq<T>(arr: T[]) {
  return Array.from(new Set(arr));
}

function asNum(x: any): number | null {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function toProofLinks(urls: string[] | undefined) {
  const arr = Array.isArray(urls) ? urls : [];
  const dedup = uniq(arr).filter(Boolean);

  return dedup.map((url) => {
    let label = "Proof";
    if (url.includes("solscan.io")) label = "Solscan";
    else if (url.includes("solana.fm")) label = "SolanaFM";
    else if (url.includes("birdeye.so")) label = "Birdeye";
    else if (url.includes("dexscreener.com")) label = "Dexscreener";
    return { label, url };
  });
}

function addSignal(signals: any[], s: Signal) {
  const raw = (s as any).proof;
  const proof = Array.isArray(raw) ? raw.map((x) => String(x)).filter(Boolean) : [];

  const dedup = Array.from(new Set(proof));

  signals.push({
    ...s,
    proof: dedup,
    proofLinks: toProofLinks(dedup),
  });
}

/* =========================================================
   Raydium LP check (Deep only)
   ========================================================= */

const RAYDIUM_API = "https://api-v3.raydium.io";
const INCINERATOR = "1nc1nerator11111111111111111111111111111111";

// (fallback) Common quote mints (mainnet)
const WSOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

async function fetchJson(url: string, ms = 6000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    const j = await r.json().catch(() => null);
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(j)}`);
    return j;
  } finally {
    clearTimeout(t);
  }
}

function extractArray(j: any): any[] {
  if (!j) return [];
  if (Array.isArray(j)) return j;
  if (Array.isArray(j.data)) return j.data;
  if (Array.isArray(j?.data?.data)) return j.data.data;
  if (Array.isArray(j?.data?.list)) return j.data.list;
  if (Array.isArray(j?.data?.pools)) return j.data.pools;
  if (Array.isArray(j?.pools)) return j.pools;
  return [];
}

function pickPoolId(pool: any): string | null {
  return (
    pool?.id ||
    pool?.poolId ||
    pool?.ammId ||
    pool?.amm_id ||
    pool?.pool_id ||
    pool?.poolIdStr ||
    pool?.pool_id_str ||
    null
  );
}

async function discoverRaydiumPoolId(
  tokenMint: string
): Promise<{ poolId: string; quote: "WSOL" | "USDC" } | null> {
  const tries: Array<{ quote: "WSOL" | "USDC"; mint: string }> = [
    { quote: "WSOL", mint: WSOL_MINT },
    { quote: "USDC", mint: USDC_MINT },
  ];

  for (const q of tries) {
    const url =
      `${RAYDIUM_API}/pools/info/mint?` +
      new URLSearchParams({
        mint1: tokenMint,
        mint2: q.mint,
        poolType: "all",
        page: "1",
        pageSize: "10",
      }).toString();

    try {
      const j = await fetchJson(url, 7000);
      const pools = extractArray(j);
      if (!pools.length) continue;

      const poolId = pickPoolId(pools[0]);
      if (poolId) return { poolId, quote: q.quote };
    } catch {
      // ignore; try next quote
    }
  }

  return null;
}

// ✅ This is the correct, single, global function (NOT nested)
async function fetchRaydiumLpMintByPoolId(poolId: string): Promise<string | null> {
  try {
    const url = `${RAYDIUM_API}/pools/info/ids?ids=${encodeURIComponent(poolId)}`;
    const r = await fetch(url, { headers: { accept: "application/json" } });
    if (!r.ok) return null;

    const j: any = await r.json().catch(() => null);
    const arr = j?.data;
    const first = Array.isArray(arr) ? arr[0] : arr;

    if (!first) return null;

    // lpMint can be:
    // - string
    // - object like { address: "..." } or { mint: "..." }
    // - nested in first.lpMint.address
    const raw = first?.lpMint ?? first?.lp_mint ?? null;

    let lp: any = raw;

    if (lp && typeof lp === "object") {
      lp = lp.address || lp.mint || lp.pubkey || lp.toString?.() || null;
    }

    if (typeof lp !== "string") return null;

    const lpMint = lp.trim();

    // sanity check: should be base58-like and not "[object Object]"
    if (!lpMint || lpMint.includes("[object")) return null;

    return lpMint;
  } catch {
    return null;
  }
}

async function calcLpBurnedPct(
  conn: Connection,
  lpMint: string
): Promise<{ burnedPct: number; burnedRaw: bigint; supplyRaw: bigint } | null> {
  const lpMintPk = new PublicKey(lpMint);

  const supplyInfo = await conn.getTokenSupply(lpMintPk);
  const supplyRaw = BigInt(supplyInfo?.value?.amount || "0");
  if (supplyRaw <= 0n) return null;

  const largest = await conn.getTokenLargestAccounts(lpMintPk);
  const accounts = largest?.value || [];
  if (!accounts.length) return null;

  let burnedRaw = 0n;

  // Keep it bounded so it won't hang
  const MAX_CHECK = Math.min(accounts.length, 12);
  for (let i = 0; i < MAX_CHECK; i++) {
    const accAddr = accounts[i]?.address;
    const amountStr = accounts[i]?.amount;
    if (!accAddr || !amountStr) continue;

    const info = await conn.getParsedAccountInfo(accAddr);
    const owner = (info?.value as any)?.data?.parsed?.info?.owner;

    if (owner === INCINERATOR) {
      burnedRaw += BigInt(amountStr);
    }
  }

  const burnedPct = Number(burnedRaw) / Number(supplyRaw);
  return { burnedPct, burnedRaw, supplyRaw };
}

/* =========================================================
   Helius Enhanced Transactions
   ========================================================= */

type HeliusEnhancedTx = {
  signature?: string;
  timestamp?: number; // seconds
  feePayer?: string;
  nativeTransfers?: Array<{
    fromUserAccount?: string;
    toUserAccount?: string;
    amount?: number; // lamports
  }>;
  tokenTransfers?: Array<{
    mint?: string;
    fromUserAccount?: string;
    toUserAccount?: string;
    tokenAmount?: number; // ui amount (usually)
  }>;
};

async function heliusEnhancedTxByAddressAsc(address: string, limit: number): Promise<HeliusEnhancedTx[]> {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) throw new Error("Missing HELIUS_API_KEY");

  const url =
    `https://api-mainnet.helius-rpc.com/v0/addresses/${address}/transactions` +
    `?api-key=${apiKey}&limit=${limit}&sort-order=asc`;

  const resp = await fetch(url, { headers: { accept: "application/json" } });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Helius enhanced tx error ${resp.status}: ${txt.slice(0, 200)}`);
  }

  const j = (await resp.json()) as any[];
  return Array.isArray(j) ? (j as HeliusEnhancedTx[]) : [];
}

/* =========================================================
   Dev candidate (same idea as your score.ts but lighter)
   ========================================================= */

async function detectDevCandidate(
  conn: Connection,
  mintPk: PublicKey
): Promise<{ dev?: string; reason: string; proof?: string[] }> {
  try {
    const mintAcc = await conn.getParsedAccountInfo(mintPk);
    const parsed: any = (mintAcc.value?.data as any)?.parsed;
    const info = parsed?.info || null;

    const mintAuth = info?.mintAuthority ?? null;
    const freezeAuth = info?.freezeAuthority ?? null;

    if (mintAuth) {
      return {
        dev: String(mintAuth),
        reason: "mintAuthority",
        proof: [explorerToken("sol", mintPk.toBase58())],
      };
    }
    if (freezeAuth) {
      return {
        dev: String(freezeAuth),
        reason: "freezeAuthority",
        proof: [explorerToken("sol", mintPk.toBase58())],
      };
    }
  } catch {
    // ignore
  }

  try {
    const sigs = await conn.getSignaturesForAddress(mintPk, { limit: 1000 });
    if (!sigs.length) return { reason: "unknown" };

    const oldest = sigs[sigs.length - 1];
    const sig = oldest.signature;

    const tx = await conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0 });
    if (!tx) return { reason: "unknown", proof: [`https://solscan.io/tx/${sig}`] };

    const keys: any[] = (tx.transaction.message as any).accountKeys || [];
    const signer = keys.find((k) => k.signer);
    const signerStr = signer?.pubkey?.toString?.() || signer?.toString?.();

    if (signerStr) {
      return {
        dev: String(signerStr),
        reason: "earliestSigner",
        proof: [`https://solscan.io/tx/${sig}`],
      };
    }
    return { reason: "unknown", proof: [`https://solscan.io/tx/${sig}`] };
  } catch {
    return { reason: "unknown" };
  }
}

/* =========================================================
   Deep analysis (slow, more accurate than base)
   ========================================================= */

async function deepAnalyzeSol(mint: string) {
  const rpc = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
  const conn = new Connection(rpc, "confirmed");
  const mintPk = new PublicKey(mint);

  const signals: any[] = [];
  const liqDebug: any = {};

  // Contract program check (Token-2022 => nonstandard / hooks possible)
  try {
    const info = await conn.getAccountInfo(mintPk);
    const owner = info?.owner?.toBase58?.();
    if (owner && owner.startsWith("TokenzQd")) {
      addSignal(signals, {
        id: "NONSTANDARD_TRANSFER",
        label: "Token is Token-2022 (extensions / hooks possible)",
        value: owner,
        weight: 5,
        proof: [explorerToken("sol", mint)],
      });
    }
  } catch {
    // ignore
  }

  // ===== LIQUIDITY (DEEP only) =====
  // Always emit ONE of: LP_OK / LP_NOT_BURNED / LP_STATUS_UNKNOWN
  try {
    const disc = await discoverTopPairViaDexScreener(mint);
    liqDebug.disc = disc || null;
    const dexPairUrl = (pairAddr: string, url?: string) => (url ? url : `https://dexscreener.com/solana/${pairAddr}`);

    if (!disc) {
      addSignal(signals, {
        id: "LP_STATUS_UNKNOWN",
        label: "Liquidity status unknown (no pool detected)",
        weight: 0,
        proof: [`https://dexscreener.com/solana/${mint}`],
      });
    } else if (disc.dexId === "pumpswap") {
      addSignal(signals, {
        id: "LP_STATUS_UNKNOWN",
        label: "PumpSwap AMM (no LP token model)",
        weight: 0,
        proof: [dexPairUrl(disc.pairAddress, disc.url)],
      });
    } else if (disc.dexId === "raydium") {
      // For CPMM, v3 info endpoint is the correct way to get lpMint.
      let poolId = disc.pairAddress;
      let lpMint = await fetchRaydiumLpMintByPoolId(poolId);
      liqDebug.poolId = poolId;
      liqDebug.lpMint = lpMint;

      // Fallback: try Raydium mint->pool discovery (WSOL/USDC)
      if (!lpMint) {
        const found = await discoverRaydiumPoolId(mint);
        if (found?.poolId) {
          poolId = found.poolId;
          lpMint = await fetchRaydiumLpMintByPoolId(poolId);
        }
      }

      if (!lpMint) {
        addSignal(signals, {
          id: "LP_STATUS_UNKNOWN",
          label: "Raydium pool detected but LP mint not resolved",
          weight: 0,
          proof: [dexPairUrl(disc.pairAddress, disc.url)], // ✅ one link
        });
      } else {
        // Guard: sometimes lpMint can still be garbage
try {
  new PublicKey(lpMint);
} catch {
  addSignal(signals, {
    id: "LP_STATUS_UNKNOWN",
    label: "Raydium LP mint invalid (API returned non-mint value)",
    weight: 0,
    proof: [dexPairUrl(disc.pairAddress, disc.url)],
  });
  // + debug
  liqDebug.lpMint_invalid = lpMint;
  return;
}
        const burned = await calcLpBurnedPct(conn, lpMint);

        if (!burned) {
          addSignal(signals, {
            id: "LP_STATUS_UNKNOWN",
            label: "LP mint resolved but burn status unknown (RPC)",
            weight: 0,
            proof: [dexPairUrl(disc.pairAddress, disc.url)], // ✅ one link
          });
        } else if (burned.burnedPct < 0.95) {
          addSignal(signals, {
            id: "LP_NOT_BURNED",
            label: "LP not burned / unlocked",
            value: `burned=${(burned.burnedPct * 100).toFixed(2)}%`,
            weight: 10,
            proof: [
              dexPairUrl(disc.pairAddress, disc.url),
              explorerToken("sol", lpMint),
              explorerAddress("sol", INCINERATOR),
            ],
          });
        } else {
          addSignal(signals, {
            id: "LP_OK",
            label: "LP burned (>=95%)",
            weight: 0,
            proof: [dexPairUrl(disc.pairAddress, disc.url)], // ✅ one link
          });
        }
      }
    } else {
      addSignal(signals, {
        id: "LP_STATUS_UNKNOWN",
        label: `DEX detected (${disc.dexId}), LP model not implemented`,
        weight: 0,
        proof: [dexPairUrl(disc.pairAddress, disc.url)],
      });
    }
  } catch {
    // never break deep
    addSignal(signals, {
      id: "LP_STATUS_UNKNOWN",
      label: "Liquidity status unknown (LP check error)",
      weight: 0,
      proof: [`https://dexscreener.com/solana/${mint}`],
    });
  }

  // Dev candidate
  const devCand = await detectDevCandidate(conn, mintPk);
  const dev = devCand.dev;

  // Enhanced TX
  let txs: HeliusEnhancedTx[] = [];
  let txError: string | null = null;

  try {
    const LIMIT = 100; // strict, avoid helius 400
    txs = await withTimeout<HeliusEnhancedTx[]>(
  heliusEnhancedTxByAddressAsc(mint, LIMIT),
  18_000
);
  } catch (e: any) {
    txError = e?.message || "enhanced tx failed";
    txs = [];
  }

  const launchTs = typeof txs[0]?.timestamp === "number" ? txs[0]!.timestamp! : null;

  // --- Buyers burst heuristics ---
  const EARLY_WINDOW_SEC = 60;
  const EARLY_WINDOW_SEC_WIDE = 180;

  const buyersEarly: string[] = [];
  const buyersEarlyWide: string[] = [];

  for (const tx of txs) {
    const ts = typeof tx.timestamp === "number" ? tx.timestamp : null;
    if (!launchTs || !ts) continue;

    const dt = ts - launchTs;
    if (dt < 0) continue;

    const tts = Array.isArray(tx.tokenTransfers) ? tx.tokenTransfers : [];
    for (const tt of tts) {
      if ((tt?.mint || "").toString() !== mint) continue;
      const to = tt?.toUserAccount;
      const amt = asNum(tt?.tokenAmount);
      if (!to || !amt || amt <= 0) continue;

      if (dt <= EARLY_WINDOW_SEC) buyersEarly.push(to);
      if (dt <= EARLY_WINDOW_SEC_WIDE) buyersEarlyWide.push(to);
    }
  }

  const uniqBuyersEarly = uniq(buyersEarly);
  const uniqBuyersEarlyWide = uniq(buyersEarlyWide);

  if (uniqBuyersEarly.length >= 6) {
    const proofSig = txs.find((t) => t?.signature)?.signature;
    addSignal(signals, {
      id: "BUNDLED_LAUNCH_OR_MEV",
      label: "Many unique buyers in first minute (possible bundled launch / snipers / MEV)",
      value: `buyers_60s=${uniqBuyersEarly.length}`,
      weight: 5,
      proof: proofSig ? [`https://solscan.io/tx/${proofSig}`] : [explorerToken("sol", mint)],
    });
  } else if (uniqBuyersEarlyWide.length >= 12) {
    const proofSig = txs.find((t) => t?.signature)?.signature;
    addSignal(signals, {
      id: "BUNDLED_LAUNCH_OR_MEV",
      label: "High buyer burst in first minutes (possible snipers / MEV)",
      value: `buyers_3m=${uniqBuyersEarlyWide.length}`,
      weight: 5,
      proof: proofSig ? [`https://solscan.io/tx/${proofSig}`] : [explorerToken("sol", mint)],
    });
  }

  // Cluster funding heuristic
  const funderToCount = new Map<string, { count: number; buyers: Set<string>; proofSig?: string }>();

  for (const tx of txs) {
    const ts = typeof tx.timestamp === "number" ? tx.timestamp : null;
    if (!launchTs || !ts) continue;
    const dt = ts - launchTs;
    if (dt < 0 || dt > 15 * 60) continue;

    const nts = Array.isArray(tx.nativeTransfers) ? tx.nativeTransfers : [];
    for (const nt of nts) {
      const from = nt?.fromUserAccount;
      const to = nt?.toUserAccount;
      const amt = asNum(nt?.amount);

      if (!from || !to || !amt || amt <= 0) continue;
      if (!uniqBuyersEarlyWide.includes(to)) continue;

      const cur = funderToCount.get(from) || { count: 0, buyers: new Set<string>(), proofSig: undefined as string | undefined };
      cur.buyers.add(to);
      cur.count = cur.buyers.size;
      if (!cur.proofSig && tx.signature) cur.proofSig = tx.signature;
      funderToCount.set(from, cur);
    }
  }

  let bestFunder: string | null = null;
  let bestCount = 0;
  let bestProofSig: string | undefined;

  for (const [funder, v] of funderToCount.entries()) {
    if (v.count > bestCount) {
      bestCount = v.count;
      bestFunder = funder;
      bestProofSig = v.proofSig;
    }
  }

  if (bestFunder && bestCount >= 5) {
    addSignal(signals, {
      id: "CLUSTER_FUNDING",
      label: "Multiple early buyers funded by the same wallet (cluster funding)",
      value: `funded_buyers=${bestCount}`,
      weight: 5,
      proof: [
        explorerAddress("sol", bestFunder),
        bestProofSig ? `https://solscan.io/tx/${bestProofSig}` : explorerToken("sol", mint),
      ],
    });
  }

  // Dev dump early heuristic
  if (dev && launchTs) {
    let totalDevOut = 0;
    let firstDumpSig: string | undefined;

    for (const tx of txs) {
      const ts = typeof tx.timestamp === "number" ? tx.timestamp : null;
      if (!ts) continue;
      const dt = ts - launchTs;
      if (dt < 0 || dt > 60 * 60) continue;

      const tts = Array.isArray(tx.tokenTransfers) ? tx.tokenTransfers : [];
      for (const tt of tts) {
        if ((tt?.mint || "").toString() !== mint) continue;
        const from = tt?.fromUserAccount;
        const amt = asNum(tt?.tokenAmount);
        if (!from || !amt || amt <= 0) continue;

        if (from === dev) {
          totalDevOut += amt;
          if (!firstDumpSig && tx.signature) firstDumpSig = tx.signature;
        }
      }
    }

    if (totalDevOut > 0) {
      let supplyUi: number | null = null;
      try {
        const supply = await conn.getTokenSupply(mintPk);
        supplyUi = typeof supply.value.uiAmount === "number" ? supply.value.uiAmount : null;
      } catch {}

      const pct = supplyUi && supplyUi > 0 ? (totalDevOut / supplyUi) * 100 : null;
      const shouldFlag = pct !== null ? pct >= 1.0 : totalDevOut >= 100_000;

      if (shouldFlag) {
        addSignal(signals, {
          id: "DEV_DUMP_EARLY",
          label: "Dev wallet moved a significant amount soon after launch (possible early dump)",
          value:
            pct !== null
              ? `dev_out=${pct.toFixed(2)}% (first 60m)`
              : `dev_out=${Math.round(totalDevOut)} (first 60m)`,
          weight: 10,
          proof: [
            explorerAddress("sol", dev),
            firstDumpSig ? `https://solscan.io/tx/${firstDumpSig}` : explorerToken("sol", mint),
            ...(devCand.proof || []),
          ],
        });
      }
    }
  }

  return {
    signals,
    meta: {
      tx_checked: txs.length,
      launch_ts: launchTs,
      dev_candidate: dev || null,
      dev_reason: devCand.reason,
      tx_error: txError,
       liq_debug: liqDebug,
    },
  };
}

/* =========================================================
   API handler
   ========================================================= */

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const chain = String(req.query.chain || "sol").toLowerCase();
  const input = String(req.query.input || "").trim();

  if (!input) return res.status(400).json({ error: "Missing input" });
  if (chain !== "sol") return res.status(400).json({ error: "score_deep currently supports only SOL" });

  try {
    new PublicKey(input);
  } catch {
    return res.status(400).json({ error: "Invalid SOL mint address" });
  }

  const ttlMs = 120_000; // 2 minutes
  const cacheKey = `deep:sol:${input}`;

  const cached = cacheGet(cacheKey, ttlMs);
  if (cached) {
    res.setHeader("x-pg-cache", "HIT");
    return res.status(200).json(cached);
  }

  const t0 = Date.now();

  try {
    const out = await deepAnalyzeSol(input);

const signals = (out && Array.isArray((out as any).signals) ? (out as any).signals : []) as Signal[];
const meta = (out && (out as any).meta ? (out as any).meta : {}) as any;

const response = {
  chain: "sol",
  input,
  signals,
  meta: {
    ...meta,
    ms: Date.now() - t0,
  },
};

    cacheSet(cacheKey, response);
    res.setHeader("x-pg-cache", "MISS");
    return res.status(200).json(response);
  } catch (e: any) {
    return res.status(500).json({
      error: e?.message || "deep scoring failed",
      chain: "sol",
      input,
      signals: [],
      meta: {
        ms: Date.now() - t0,
        tx_error: e?.message || null,
      },
    });
  }
}