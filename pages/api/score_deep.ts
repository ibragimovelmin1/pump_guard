// pages/api/score_deep.ts
import type { NextApiRequest, NextApiResponse } from "next";
import type { Signal } from "../../lib/types";
import { Connection, PublicKey } from "@solana/web3.js";
import { explorerAddress, explorerToken } from "../../lib/explorer";

/* =========================================================
   In-memory cache (shared global map)
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
  return arr.map((url) => {
    let label = "Proof";
    if (url.includes("solscan.io")) label = "Solscan";
    else if (url.includes("solana.fm")) label = "SolanaFM";
    else if (url.includes("birdeye.so")) label = "Birdeye";
    else if (url.includes("dexscreener.com")) label = "Dexscreener";
    return { label, url };
  });
}

function addSignal(signals: any[], s: Signal) {
  const proof = Array.isArray((s as any).proof) ? (s as any).proof : [];
  signals.push({
    ...s,
    proof,
    proofLinks: toProofLinks(proof),
  });
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

async function heliusEnhancedTxByAddressAsc(
  address: string,
  limit: number
): Promise<HeliusEnhancedTx[]> {
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
  // 1) Mint account authorities (fast)
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

  // 2) Fallback: oldest tx signer (slower)
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

  // Contract program check (Token-2022 => nonstandard / hooks possible)
  try {
    const info = await conn.getAccountInfo(mintPk);
    const owner = info?.owner?.toBase58?.();
    // Token-2022 program id commonly:
    // TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
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

  // Dev candidate for dev-dump heuristics
  const devCand = await detectDevCandidate(conn, mintPk);
  const dev = devCand.dev;

  // Pull first N enhanced transactions where mint address is involved
  // (oldest first => good for launch analysis)
  const LIMIT = 120; // slower but still manageable
  const txs = await withTimeout(heliusEnhancedTxByAddressAsc(mint, LIMIT), 18_000);

  // If nothing, return empty deep
  if (!txs.length) {
    return {
      signals,
      meta: { tx_checked: 0, note: "No enhanced transactions found" },
    };
  }

  const launchTs = typeof txs[0]?.timestamp === "number" ? txs[0]!.timestamp! : null;

  // --- Collect buyers in the very early window (bundled launch heuristic)
  const EARLY_WINDOW_SEC = 60; // strict: 60s
  const EARLY_WINDOW_SEC_WIDE = 180; // wider: 3min

  const buyersEarly: string[] = [];
  const buyersEarlyWide: string[] = [];

  for (const tx of txs) {
    const ts = typeof tx.timestamp === "number" ? tx.timestamp : null;
    if (!launchTs || !ts) continue;

    const dt = ts - launchTs;
    if (dt < 0) continue;

    // tokenTransfers: treat "toUserAccount" as buyer (receiving token)
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

  // Bundled / sniper / MEV heuristic:
  // If many unique buyers appear extremely quickly (first 60s), flag it.
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

  // Cluster funding heuristic:
  // In early window, many buyers receiving SOL from same funder.
  // We'll scan nativeTransfers to find funders who funded multiple buyers.
  const funderToCount = new Map<string, { count: number; buyers: Set<string>; proofSig?: string }>();

  for (const tx of txs) {
    const ts = typeof tx.timestamp === "number" ? tx.timestamp : null;
    if (!launchTs || !ts) continue;
    const dt = ts - launchTs;
    if (dt < 0 || dt > 15 * 60) continue; // first 15 minutes

    const nts = Array.isArray(tx.nativeTransfers) ? tx.nativeTransfers : [];
    for (const nt of nts) {
      const from = nt?.fromUserAccount;
      const to = nt?.toUserAccount;
      const amt = asNum(nt?.amount);

      if (!from || !to || !amt || amt <= 0) continue;

      // If "to" is among early buyers wide, treat it as funding
      if (!uniqBuyersEarlyWide.includes(to)) continue;

      const cur = funderToCount.get(from) || { count: 0, buyers: new Set<string>(), proofSig: undefined };
      cur.buyers.add(to);
      cur.count = cur.buyers.size;
      if (!cur.proofSig && tx.signature) cur.proofSig = tx.signature;
      funderToCount.set(from, cur);
    }
  }

  // Pick best cluster funder
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

  // Dev dump early heuristic (requires dev candidate)
  // We look for tokenTransfers of this mint where fromUserAccount == dev in first 60 minutes
  if (dev && launchTs) {
    let totalDevOut = 0;
    let firstDumpSig: string | undefined;

    for (const tx of txs) {
      const ts = typeof tx.timestamp === "number" ? tx.timestamp : null;
      if (!ts) continue;
      const dt = ts - launchTs;
      if (dt < 0 || dt > 60 * 60) continue; // first 60 minutes

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

    // threshold: if dev sent out "a lot" of tokens early (absolute heuristic)
    // For more accuracy, we later compare vs supply and %; for now it flags big early movement.
    if (totalDevOut > 0) {
      // Make it stricter: only if > 1% of supply (when supply is available)
      let supplyUi: number | null = null;
      try {
        const supply = await conn.getTokenSupply(mintPk);
        supplyUi = typeof supply.value.uiAmount === "number" ? supply.value.uiAmount : null;
      } catch {}

      const pct = supplyUi && supplyUi > 0 ? (totalDevOut / supplyUi) * 100 : null;

      // If we can compute %, use it; otherwise require higher absolute amount
      const shouldFlag =
        pct !== null ? pct >= 1.0 : totalDevOut >= 100_000;

      if (shouldFlag) {
        addSignal(signals, {
          id: "DEV_DUMP_EARLY",
          label: "Dev wallet moved a significant amount soon after launch (possible early dump)",
          value: pct !== null ? `dev_out=${pct.toFixed(2)}% (first 60m)` : `dev_out=${Math.round(totalDevOut)} (first 60m)`,
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

  // Validate mint
  try {
    // will throw if invalid
    new PublicKey(input);
  } catch {
    return res.status(400).json({ error: "Invalid SOL mint address" });
  }

  // Deep cache: short TTL (because TX patterns can change quickly)
  // You can tune this later.
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

    const response = {
      chain: "sol",
      input,
      signals: out.signals as Signal[],
      meta: {
        ...out.meta,
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
      meta: { ms: Date.now() - t0 },
    });
  }
}