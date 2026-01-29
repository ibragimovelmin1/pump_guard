// lib/dexscreener.ts
// DexScreener discovery with in-memory TTL cache.
// NOTE: Safe for serverless – cache is best-effort (may reset between cold starts).

export type DexDiscovery = {
  dexId: string;       // e.g. "raydium", "pumpswap", "orca", ...
  pairAddress: string; // DexScreener pair address
  quoteMint?: string;  // quote token mint when available
  url?: string;        // DexScreener URL for the pair
};

type CacheEntry<T> = { exp: number; val: T };
const cache = new Map<string, CacheEntry<DexDiscovery | null>>();

function nowMs() {
  return Date.now();
}

function getCached(key: string): DexDiscovery | null | undefined {
  const e = cache.get(key);
  if (!e) return undefined;
  if (e.exp <= nowMs()) {
    cache.delete(key);
    return undefined;
  }
  return e.val;
}

function setCached(key: string, val: DexDiscovery | null, ttlMs: number) {
  cache.set(key, { exp: nowMs() + ttlMs, val });
}

function pickTopPair(pairs: any[]): any | null {
  if (!Array.isArray(pairs) || pairs.length === 0) return null;

  // Prefer highest liquidity.usd, then highest 24h volume.
  const scored = pairs
    .map((p) => {
      const liq = Number(p?.liquidity?.usd ?? 0);
      const vol = Number(p?.volume?.h24 ?? 0);
      return { p, liq, vol };
    })
    .sort((a, b) => (b.liq - a.liq) || (b.vol - a.vol));

  return scored[0]?.p ?? null;
}

export async function discoverTopPairViaDexScreener(
  mint: string,
  ttlMs: number = 7 * 60 * 1000 // 7 min
): Promise<DexDiscovery | null> {
  const key = `dexscreener:${mint}`;
  const cached = getCached(key);
  if (cached !== undefined) return cached;

  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;
    const res = await fetch(url, { headers: { "accept": "application/json" } });
    if (!res.ok) {
      setCached(key, null, ttlMs);
      return null;
    }

    const data = await res.json();
    const top = pickTopPair(data?.pairs ?? []);
    if (!top) {
      setCached(key, null, ttlMs);
      return null;
    }

    const discovery: DexDiscovery = {
      dexId: String(top?.dexId ?? "").toLowerCase(),
      pairAddress: String(top?.pairAddress ?? ""),
      quoteMint: top?.quoteToken?.address ? String(top.quoteToken.address) : undefined,
      url: top?.url ? String(top.url) : undefined,
    };

    // Must have pairAddress to be useful
    if (!discovery.pairAddress) {
      setCached(key, null, ttlMs);
      return null;
    }

    setCached(key, discovery, ttlMs);
    return discovery;
  } catch {
    setCached(key, null, ttlMs);
    return null;
  }
}