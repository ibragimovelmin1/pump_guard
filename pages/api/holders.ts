import type { NextApiRequest, NextApiResponse } from "next";

/* =========================================================
   In-memory cache (same global map approach)
   ========================================================= */

type CacheEntry = { ts: number; value: any };

const __PG_CACHE: Map<string, CacheEntry> =
  (globalThis as any).__PG_CACHE || new Map();
(globalThis as any).__PG_CACHE = __PG_CACHE;

function cacheGetRaw(key: string) {
  return __PG_CACHE.get(key)?.value ?? null;
}
function cacheSetRaw(key: string, value: any) {
  __PG_CACHE.set(key, { ts: Date.now(), value });
}
function cacheDel(key: string) {
  __PG_CACHE.delete(key);
}

/* =========================================================
   Helius RPC helper
   ========================================================= */

async function heliusRpc<T>(body: any): Promise<T> {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) throw new Error("Missing HELIUS_API_KEY");

 const url = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
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

/* =========================================================
   Types
   ========================================================= */

type TokenAccountsResp = {
  token_accounts?: Array<{ owner?: string; amount?: number }>;
  cursor?: string;
};

type HoldersState = {
  owners: Set<string>;
  cursor?: string;
  pages: number;
  startedAt: number;
  updatedAt: number;
};

/* =========================================================
   Handler
   ========================================================= */

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const mint = String(req.query.mint || "").trim();
  if (!mint) return res.status(400).json({ error: "Missing mint" });

  if (!process.env.HELIUS_API_KEY) {
    return res.status(500).json({ error: "Missing HELIUS_API_KEY" });
  }

  // One mint = one incremental job state (in-memory)
  const key = `holders_job:${mint}`;

  const action = String(req.query.action || "step"); // "start" | "step" | "reset"
  if (action === "reset") {
    cacheDel(key);
    return res.status(200).json({ status: "reset" });
  }

  // Init state if missing OR explicit start
  let state: HoldersState | null = cacheGetRaw(key);
  if (!state || action === "start") {
    state = {
      owners: new Set<string>(),
      cursor: undefined,
      pages: 0,
      startedAt: Date.now(),
      updatedAt: Date.now(),
    };
    cacheSetRaw(key, state);
  }

  // Safety: if state too old, restart (avoid zombie jobs)
  const JOB_TTL_MS = 10 * 60_000; // 10 min
  if (Date.now() - state.startedAt > JOB_TTL_MS) {
    cacheDel(key);
    return res.status(200).json({ status: "expired", hint: "Restart holders job" });
  }

  // Do exactly ONE page per request (fast, avoids serverless timeout)
  const LIMIT = 1000;

  try {
    const page = await heliusRpc<TokenAccountsResp>({
      jsonrpc: "2.0",
      id: `holders-step-${state.pages}`,
      method: "getTokenAccounts",
      params: {
        mint,
        limit: LIMIT,
        cursor: state.cursor,
      },
    });

    const arr = page?.token_accounts ?? [];
    for (const ta of arr) {
      if (ta?.owner && (ta.amount ?? 0) > 0) state.owners.add(ta.owner);
    }

    state.pages += 1;
    state.updatedAt = Date.now();

    // done if no cursor OR empty page
    const done = !page?.cursor || arr.length === 0;

    if (done) {
      const holders = state.owners.size;
      // store final cached value separately for quick reuse
      cacheSetRaw(`holders_final:${mint}`, { holders, ts: Date.now() });
      // clean job state (optional). Keep it if you want resume.
      cacheDel(key);

      return res.status(200).json({
        status: "done",
        holders,
        pages: state.pages,
        scanned_accounts: state.pages * LIMIT,
      });
    }

    // persist state for next step
    state.cursor = page.cursor;
    cacheSetRaw(key, state);

    return res.status(200).json({
      status: "running",
      pages: state.pages,
      holders_so_far: state.owners.size,
      scanned_accounts: state.pages * LIMIT,
    });
  } catch (e: any) {
    return res.status(500).json({
      status: "error",
      error: String(e?.message || e),
    });
  }
}