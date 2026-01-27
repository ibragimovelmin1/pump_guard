import { useMemo, useState, useEffect } from "react";
import type { ChainAuto, ScoreResponse, Signal } from "../lib/types";
import { detectChain } from "../lib/detect";

/* =========================
   Helpers
   ========================= */

type RiskLevel = "LOW" | "MEDIUM" | "HIGH";

function RiskBadge({ level }: { level: RiskLevel | string }) {
  const emoji = level === "HIGH" ? "🔴" : level === "MEDIUM" ? "🟡" : "🟢";
  return <span className="badge">{emoji} {String(level)}</span>;
}

// confidence = trust → HIGH green, LOW red
function ConfidenceBadge({ level }: { level: RiskLevel | string }) {
  const emoji = level === "HIGH" ? "🟢" : level === "MEDIUM" ? "🟡" : "🔴";
  return <span className="badge">{emoji} {String(level)}</span>;
}

function formatAge(sec?: number) {
  if (!sec && sec !== 0) return "—";
  if (sec < 60) return "<1m";
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

function formatHolders(v: any) {
  if (typeof v === "number" && Number.isFinite(v)) return v.toLocaleString();
  return "—";
}

/* =========================
   Proof links helpers (works with both proof[] and proofLinks[])
   ========================= */

function getProofLinks(signal: any): { label: string; url: string }[] {
  const pl = Array.isArray(signal?.proofLinks) ? signal.proofLinks : null;
  if (pl && pl.length) {
    return pl
      .filter((x: any) => x?.url)
      .map((x: any) => ({ label: x.label || "Proof", url: x.url }));
  }
  const p = Array.isArray(signal?.proof) ? signal.proof : null;
  if (p && p.length) {
    return p
      .filter((u: any) => typeof u === "string")
      .map((url: string) => {
        let label = "Proof";
        if (url.includes("solscan.io")) label = "Solscan";
        else if (url.includes("solana.fm")) label = "SolanaFM";
        else if (url.includes("birdeye.so")) label = "Birdeye";
        else if (url.includes("dexscreener.com")) label = "Dexscreener";
        return { label, url };
      });
  }
  return [];
}

function ProofLinksInline({ signal }: { signal: any }) {
  const links = getProofLinks(signal);
  if (!links.length) return null;
  return (
    <div className="row" style={{ gap: 10, flexWrap: "wrap", justifyContent: "flex-end", marginTop: 6 }}>
      {links.slice(0, 3).map((l) => (
        <a
          key={l.url}
          href={l.url}
          target="_blank"
          rel="noreferrer"
          className="small"
          style={{ textDecoration: "underline", opacity: 0.85 }}
        >
          {l.label}
        </a>
      ))}
    </div>
  );
}

/* =========================
   Merge signals (deep overwrites base by id)
   ========================= */

function mergeSignals(base: Signal[], deep: Signal[]) {
  const map = new Map<string, Signal>();
  (base || []).forEach((s) => map.set(s.id, s));
  (deep || []).forEach((s) => map.set(s.id, s));
  return Array.from(map.values());
}

/* =========================
   Verdict + Share
   ========================= */

type VerdictLevel = "LOW" | "MEDIUM" | "HIGH";

function verdictFromScore(score: number): VerdictLevel {
  if (score >= 67) return "HIGH";
  if (score >= 34) return "MEDIUM";
  return "LOW";
}

const VERDICT_COPY: Record<VerdictLevel, { headline: string; bullets: string[]; action: string }> = {
  LOW: {
    headline: "Low risk signals detected",
    bullets: [
      "No critical red flags detected in current on-chain signals.",
      "Always manage position size and exit plan.",
    ],
    action: "Good for quick pre-entry checks. Still not risk-free.",
  },
  MEDIUM: {
    headline: "Moderate risk signals detected",
    bullets: [
      "Some on-chain risk signals are present.",
      "Potential concerns require manual review.",
    ],
    action: "Consider smaller size and faster invalidation.",
  },
  HIGH: {
    headline: "High risk signals detected",
    bullets: [
      "Multiple red flags detected in on-chain behavior.",
      "Patterns resemble common rug scenarios.",
    ],
    action: "Avoid or treat as extremely high risk.",
  },
};

function makeHashtags(args: { chain?: string; level?: "LOW" | "MEDIUM" | "HIGH"; tokenSymbol?: string }) {
  const tags = new Set<string>();
  tags.add("#PUMPGUARD");
  tags.add("#Crypto");

  const c = (args.chain || "").toLowerCase();
  if (c === "sol") tags.add("#Solana");
  if (c === "eth") tags.add("#Ethereum");
  if (c === "bnb") tags.add("#BNBChain");

  if (args.level === "LOW") tags.add("#LowRisk");
  if (args.level === "MEDIUM") tags.add("#MediumRisk");
  if (args.level === "HIGH") tags.add("#HighRisk");

  const sym = (args.tokenSymbol || "").trim().toUpperCase();
  if (sym && sym.length <= 10 && /^[A-Z0-9_]+$/.test(sym)) tags.add(`#${sym}`);

  return Array.from(tags).slice(0, 5).join(" ");
}

function signalEmoji(id: string, weight?: number) {
  const x = String(id || "").toUpperCase();
  const w = Number(weight ?? 0) || 0;

  if (x.includes("DEV_DUMP") || x.includes("BUNDLED") || x.includes("MEV") || x.includes("CLUSTER"))
    return w >= 10 ? "🔥" : "💣";

  if (x.includes("BLACKLIST") || x.includes("TRANSFER_BLOCK")) return "⛔";
  if (x.includes("HIGH_TAX") || x.includes("TAX")) return "⚖️";
  if (x.includes("NONSTANDARD") || x.includes("HOOK")) return "🧩";

  if (x.includes("MINT_AUTHORITY")) return "⚠️";
  if (x.includes("FREEZE_AUTHORITY")) return "🧊";

  if (x.startsWith("TOP10_")) return w >= 10 ? "🐋" : "📊";
  if (x.startsWith("DEV_HOLDS_")) return "👤";

  if (x.startsWith("LP_")) return "💧";

  return "⚠️";
}

function shortSignalLabel(id: string, label: string) {
  const x = id.toUpperCase();

  if (x.includes("DEV_DUMP")) return "Dev early dump";
  if (x.includes("BLACKLIST") || x.includes("TRANSFER_BLOCK")) return "Transfer blocked";
  if (x.includes("BUNDLED")) return "Bundled launch";
  if (x.includes("MEV")) return "MEV activity";

  if (x.includes("MINT_AUTHORITY")) return "Mint authority active";
  if (x.includes("FREEZE_AUTHORITY")) return "Freeze authority active";

  if (x.startsWith("TOP10_")) return "Whale concentration";
  if (x.startsWith("DEV_HOLDS_")) return "Dev holds supply";

  if (x.startsWith("LP_")) return "LP risk";

  return label;
}

function pickSmartSignals(args: {
  signals: { id: string; label: string; weight?: number }[];
  level: "LOW" | "MEDIUM" | "HIGH";
  limit?: number;
}) {
  const limit = args.limit ?? 2;

  const EXCLUDE = [
    "LP_STATUS_UNKNOWN",
    "DEMO_MODE",
    "LIVE_ERROR",
    "DEV_CANDIDATE",
    "DEV_UNKNOWN",
  ];

  const filtered = (args.signals || []).filter(s => {
    if (!s || !s.id) return false;
    if (EXCLUDE.some(x => s.id.includes(x))) return false;
    return (Number(s.weight ?? 0) || 0) > 0;
  });

  filtered.sort((a, b) => (Number(b.weight ?? 0) || 0) - (Number(a.weight ?? 0) || 0));

  if (args.level === "HIGH") {
    return filtered.slice(0, limit).map(s => `${signalEmoji(s.id, s.weight)} ${shortSignalLabel(s.id, s.label)}`);
  }
  if (args.level === "MEDIUM") {
    return filtered.slice(0, limit).map(s => `${signalEmoji(s.id, s.weight)} ${shortSignalLabel(s.id, s.label)}`);
  }
  return filtered.slice(-limit).map(s => `${signalEmoji(s.id, s.weight)} ${shortSignalLabel(s.id, s.label)}`);
}

function toTweetText(args: {
  chain: string;
  score: number;
  level: VerdictLevel;
  confidence?: string;
  topSignals: string[];
  url: string;
  tokenName?: string;
  tokenSymbol?: string;
  tokenAddress?: string;
}) {
  const emoji = args.level === "HIGH" ? "🔴" : args.level === "MEDIUM" ? "🟡" : "🟢";

  const title =
    args.tokenName
      ? `${args.tokenName}${args.tokenSymbol ? ` (${args.tokenSymbol})` : ""}`
      : args.tokenSymbol || "Token";

  const contractBlock = args.tokenAddress
    ? `Contract:\n${args.tokenAddress}\n`
    : "";

  const signalsBlock =
    args.topSignals.length > 0
      ? `\nWHY:\n• ${args.topSignals.join("\n• ")}`
      : "";

  const hashtags = makeHashtags({
    chain: args.chain,
    level: args.level,
    tokenSymbol: args.tokenSymbol,
  });

  return (
    `Checked with PUMP.GUARD\n\n` +
    `${emoji} ${title}\n` +
    `Risk: ${args.score} / 100 (${args.level})\n` +
    `Chain: ${args.chain.toUpperCase()}\n` +
    (args.confidence ? `Confidence: ${args.confidence}\n` : "") +
    `${signalsBlock}\n\n` +
    contractBlock +
    `\nNot financial advice.\n` +
    `${args.url}\n\n` +
    `${hashtags}`
  );
}

function makeXIntentUrl(text: string) {
  return `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`;
}

/* =========================
   Community flags
   ========================= */

type FlagsResp = {
  rugged: number;
  sus: number;
  trusted: number;
  recent: { type: "RUGGED" | "SUS" | "TRUSTED"; reason?: string; ts: string }[];
  note?: string;
  error?: string;
};

/* =========================
   Risk breakdown (by model)
   ========================= */

type SignalCategory = "PERMISSIONS" | "DISTRIBUTION" | "LIQUIDITY" | "DEV_CONTRACT" | "TX_PATTERNS";

function categorizeSignalId(id: string): SignalCategory | null {
  const x = String(id || "").toUpperCase();

  if (x.includes("MINT_AUTHORITY") || x.includes("FREEZE_AUTHORITY")) return "PERMISSIONS";
  if (x.startsWith("TOP10_") || x.startsWith("DEV_HOLDS_")) return "DISTRIBUTION";
  if (x.startsWith("LP_")) return "LIQUIDITY";

  if (
    x.includes("BLACKLIST") ||
    x.includes("TRANSFER_BLOCK") ||
    x.includes("HIGH_TAX") ||
    x.includes("NONSTANDARD_TRANSFER") ||
    x.includes("HOOK")
  ) return "DEV_CONTRACT";

  if (x.includes("DEV_DUMP") || x.includes("BUNDLED") || x.includes("MEV") || x.includes("CLUSTER"))
    return "TX_PATTERNS";

  return null;
}

const CATEGORY_CAP: Record<SignalCategory, number> = {
  PERMISSIONS: 10,
  DISTRIBUTION: 30,
  LIQUIDITY: 10,
  DEV_CONTRACT: 30,
  TX_PATTERNS: 20,
};

function sumByCategory(signals: { id: string; weight?: any }[]) {
  const buckets: Record<SignalCategory, number> = {
    PERMISSIONS: 0,
    DISTRIBUTION: 0,
    LIQUIDITY: 0,
    DEV_CONTRACT: 0,
    TX_PATTERNS: 0,
  };

  for (const s of signals || []) {
    const cat = categorizeSignalId(String(s?.id ?? ""));
    if (!cat) continue;
    const w = Number(s?.weight ?? 0) || 0;
    buckets[cat] += w;
  }

  (Object.keys(buckets) as SignalCategory[]).forEach(cat => {
    buckets[cat] = Math.max(0, Math.min(CATEGORY_CAP[cat], buckets[cat]));
  });

  return buckets;
}

/* =========================
   WHY model (11 criteria)
   ========================= */

type WhyRow = { id: string; label: string; points: number };

const WHY_GROUPS: { title: string; cap: number; rows: WhyRow[] }[] = [
  {
    title: "PERMISSIONS",
    cap: 10,
    rows: [
      { id: "MINT_AUTHORITY_PRESENT", label: "Mint authority present", points: 5 },
      { id: "FREEZE_AUTHORITY_PRESENT", label: "Freeze authority present", points: 5 },
    ],
  },
  {
    title: "DISTRIBUTION",
    cap: 30,
    rows: [
      { id: "TOP10_DYNAMIC", label: "Top-10 token accounts >", points: 0 },
      { id: "DEV_HOLDS_DYNAMIC", label: "Dev wallet holds >", points: 0 },
    ],
  },
  {
    title: "TX PATTERNS",
    cap: 20,
    rows: [
      { id: "DEV_DUMP_EARLY", label: "Dev dumps shortly after launch", points: 10 },
      { id: "BUNDLED_LAUNCH_OR_MEV", label: "Bundled launch / sniper / MEV", points: 5 },
      { id: "CLUSTER_FUNDING", label: "Cluster funding", points: 5 },
    ],
  },
  {
    title: "DEV / CONTRACT",
    cap: 30,
    rows: [
      { id: "BLACKLIST_OR_TRANSFER_BLOCK", label: "Blacklist / transfer blocking", points: 15 },
      { id: "HIGH_TAX", label: "High buy/sell tax", points: 10 },
      { id: "NONSTANDARD_TRANSFER", label: "Non-standard transfer logic / hooks", points: 5 },
    ],
  },
  {
    title: "LIQUIDITY (LP)",
    cap: 10,
    rows: [{ id: "LP_NOT_BURNED", label: "LP not burned / unlocked", points: 10 }],
  },
];

/* =========================
   Page
   ========================= */

export default function Home() {
  const [input, setInput] = useState("");
  const [chain, setChain] = useState<ChainAuto>("auto");
  const [type, setType] = useState<"token" | "wallet">("token");

  const [loading, setLoading] = useState(false);
  const [deepLoading, setDeepLoading] = useState(false);
  const [holdersLoading, setHoldersLoading] = useState(false);
  const [data, setData] = useState<ScoreResponse | null>(null);
  const [deepSignals, setDeepSignals] = useState<Signal[]>([]);
  const [error, setError] = useState("");

  const detected = useMemo(() => detectChain(input) ?? "—", [input]);

  /* ---------- Community flags state ---------- */
  const [flags, setFlags] = useState<FlagsResp | null>(null);
  const [flagReason, setFlagReason] = useState("");
  const [flagLoading, setFlagLoading] = useState<"RUGGED" | "SUS" | "TRUSTED" | "">("");
  const [flagErr, setFlagErr] = useState("");

  const target = useMemo(() => {
    if (!data) return null;
    const target_type = data.input_type === "token" ? "token" : "dev";
    const target_address = data.input_type === "token" ? data.token?.address : data.dev?.address;
    if (!target_address) return null;
    return { chain: data.chain, target_type, target_address };
  }, [data]);

  async function fetchFlags() {
    if (!target) return;
    setFlagErr("");
    try {
      const qs = new URLSearchParams({
        chain: target.chain,
        target_type: target.target_type,
        target_address: target.target_address,
      });
      const res = await fetch(`/api/flags?${qs.toString()}`);
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error || "Failed to load flags");
      setFlags(j);
    } catch (e: any) {
      setFlags(null);
      setFlagErr(e?.message || "Failed to load flags");
    }
  }

  async function submitFlag(flag_type: "RUGGED" | "SUS" | "TRUSTED") {
    if (!target) return;
    setFlagLoading(flag_type);
    setFlagErr("");
    try {
      const res = await fetch("/api/flag", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chain: target.chain,
          target_type: target.target_type,
          target_address: target.target_address,
          flag_type,
          reason: flagReason,
        }),
      });

      const j = await res.json();
      if (!res.ok) throw new Error(j?.error || "Failed to submit flag");
      setFlagReason("");
      await fetchFlags();
    } catch (e: any) {
      setFlagErr(e?.message || "Failed to submit flag");
    } finally {
      setFlagLoading("");
    }
  }

  useEffect(() => {
    if (target) fetchFlags();
    else setFlags(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.chain, target?.target_type, target?.target_address]);

  /* ---------- Main request ---------- */
  async function run() {
    async function loadHoldersSol(mint: string) {
  try {
    setHoldersLoading(true);

    // start job
    await fetch(`/api/holders?mint=${encodeURIComponent(mint)}&action=start`).catch(() => {});

    // poll until done
    const MAX_STEPS = 60;
    for (let i = 0; i < MAX_STEPS; i++) {
      const r = await fetch(`/api/holders?mint=${encodeURIComponent(mint)}&action=step`);
      const j = await r.json();

      if (j?.status === "done" && typeof j.holders === "number") {
        setData(prev => {
          if (!prev?.token) return prev;
          return {
            ...prev,
            token: { ...prev.token, holders: j.holders },
          };
        });
        return;
      }

      if (j?.status === "error") return;

      await new Promise(res => setTimeout(res, 250));
    }
  } finally {
    setHoldersLoading(false);
  }
}
    setLoading(true);
    setDeepLoading(false);
    setError("");
    setData(null);
    setDeepSignals([]);
    setFlags(null);

    try {
      const qs = new URLSearchParams({ input, chain, type });
      const res = await fetch(`/api/score?${qs.toString()}`);
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error || "Request failed");
      setData(j);
      // holders incremental (SOL token)
if ((j?.chain || chain) === "sol" && type === "token" && j?.token?.address) {
  loadHoldersSol(j.token.address);
}

      // start deep in background (only for SOL tokens)
      const effectiveChain = (j?.chain || chain) as string;
      if (effectiveChain === "sol" && type === "token") {
        setDeepLoading(true);
        fetch(`/api/score_deep?chain=sol&input=${encodeURIComponent(input)}`)
          .then(r => r.json())
          .then(j2 => {
            if (Array.isArray(j2?.signals)) setDeepSignals(j2.signals);
          })
          .catch(() => {})
          .finally(() => setDeepLoading(false));
      }
    } catch (e: any) {
      setError(e?.message || "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  // merged signals (deep overwrites base)
  const mergedSignals = useMemo(() => {
    if (!data) return [];
    return mergeSignals(data.signals ?? [], deepSignals ?? []);
  }, [data, deepSignals]);

  /* ---------- Dynamic rows ---------- */
  function resolveTop10() {
    if (!data) return null;
    if (mergedSignals.find(s => s.id === "TOP10_GT_80")) return { txt: "80%", pts: 15, id: "TOP10_GT_80" };
    if (mergedSignals.find(s => s.id === "TOP10_GT_60")) return { txt: "60%", pts: 10, id: "TOP10_GT_60" };
    if (mergedSignals.find(s => s.id === "TOP10_GT_40")) return { txt: "40%", pts: 5, id: "TOP10_GT_40" };
    return null;
  }

  function resolveDevHolds() {
    if (!data) return null;
    if (mergedSignals.find(s => s.id === "DEV_HOLDS_GT_50")) return { txt: "50%", pts: 15, id: "DEV_HOLDS_GT_50" };
    if (mergedSignals.find(s => s.id === "DEV_HOLDS_GT_30")) return { txt: "30%", pts: 10, id: "DEV_HOLDS_GT_30" };
    return null;
  }

  const tokenTitle = useMemo(() => {
    if (!data?.token) return null;

    const name = data.token.name?.trim();
    const symbol = data.token.symbol?.trim();

    if (name && symbol) return `${name} (${symbol})`;
    if (name) return name;
    if (symbol) return symbol;

    const addr = data.token.address;
    return addr ? `${addr.slice(0, 4)}...${addr.slice(-4)}` : null;
  }, [data?.token?.name, data?.token?.symbol, data?.token?.address]);

  // helper: find signal by id in merged list
  function findSig(id: string) {
    return mergedSignals.find(s => s.id === id);
  }

  // helper: deep-only criteria ids (used for loaders)
  const DEEP_IDS = [
    "DEV_DUMP_EARLY",
    "BUNDLED_LAUNCH_OR_MEV",
    "CLUSTER_FUNDING",
    "NONSTANDARD_TRANSFER",
    "BLACKLIST_OR_TRANSFER_BLOCK",
    "HIGH_TAX",
    "LP_NOT_BURNED",
  ];

  const hasAnyDeepSignal = useMemo(() => {
    return DEEP_IDS.some(id => Boolean(findSig(id)));
  }, [mergedSignals]);

  return (
    <>
      <div className="nav">
        <div className="wrap nav-inner">
          <div className="brand">
            PUMP<span className="grad">.GUARD</span> <span className="small">MVP</span>
          </div>
          <div className="small">Not financial advice. Just signals.</div>
        </div>
      </div>

      {/* small css helper for 3-column row */}
      <style jsx>{`
        .grid3 { display: grid; grid-template-columns: 1fr; gap: 14px; }
        @media(min-width: 900px){ .grid3 { grid-template-columns: 1fr 1fr 1fr; } }
      `}</style>

      <main className="wrap" style={{ padding: "22px 0 40px" }}>
        {/* TOP */}
        <div className="grid">
          {/* INPUT */}
          <div className="card">
            <h1 style={{ margin: "0 0 8px" }}>Check the risk before you buy</h1>
            <div className="small">Paste a token or dev wallet. Chain auto-detect supported.</div>

            <div style={{ height: 12 }} />

            <input
              className="input"
              placeholder="Token address (SOL / 0x...) or wallet"
              value={input}
              onChange={(e) => setInput(e.target.value)}
            />

            <div style={{ height: 12 }} />

            <div className="row">
              <select className="input" value={chain} onChange={(e) => setChain(e.target.value as any)}>
                <option value="auto">auto (detected: {detected})</option>
                <option value="sol">sol</option>
                <option value="eth">eth</option>
                <option value="bnb">bnb</option>
              </select>

              <button className="btn btn-primary" disabled={!input || loading} onClick={run}>
                {loading ? "Checking..." : "Check risk"}
              </button>
            </div>
          </div>

          {/* RISK */}
          <div className="card">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div className="badge">{data?.chain?.toUpperCase() ?? "—"}</div>
              <div style={{ fontWeight: 900, fontSize: 22 }}>
                {data ? `${data.risk.score} / 100` : "0 / 100"}
              </div>
            </div>

            <hr />
            {tokenTitle && (
              <>
                <div className="small">Token</div>
                <div style={{ fontWeight: 900, fontSize: 18 }}>
                  {tokenTitle}
                </div>
                <div style={{ height: 10 }} />
              </>
            )}

            <div className="small">Dev wallet</div>
            <div style={{ wordBreak: "break-all" }}>{data?.dev?.address ?? "—"}</div>

            <div style={{ height: 8 }} />

            <div className="small">Token age</div>
            <div>{formatAge(data?.token?.age_seconds)}</div>

            <div style={{ height: 8 }} />

            <div className="small">Holders</div>
            <div>{holdersLoading ? "Loading…" : formatHolders(data?.token?.holders)}</div>


            <div style={{ height: 10 }} />

            <div className="row" style={{ gap: 10 }}>
              <div>
                <div className="small">Risk</div>
                <RiskBadge level={data?.risk.level ?? "LOW"} />
              </div>

              <div>
                <div className="small">Confidence</div>
                <ConfidenceBadge level={data?.risk.confidence ?? "LOW"} />
              </div>
            </div>

            <div className="small" style={{ opacity: 0.6, marginTop: 8 }}>
              Info only — does not affect score
            </div>

            {/* deep status hint */}
            {data?.chain === "sol" && type === "token" && (
              <div className="small" style={{ opacity: 0.7, marginTop: 10 }}>
                {deepLoading ? "Deep checks running…" : (hasAnyDeepSignal ? "Deep checks complete." : "Deep checks: no additional signals.")}
              </div>
            )}
          </div>
        </div>

        {/* ERROR */}
        {error && (
          <>
            <div style={{ height: 14 }} />
            <div className="card"><b>Error:</b> {error}</div>
          </>
        )}

        {/* WHY */}
        {data && (
          <>
            <div style={{ height: 14 }} />
            <div className="card">
              <div style={{ fontWeight: 900 }}>WHY (signals)</div>
              <div className="small">These checks may affect the score</div>
              <hr />

              {/* Info-only LP unknown card (as before) */}
              {mergedSignals?.some(s => s.id === "LP_STATUS_UNKNOWN") && (
                <div className="card" style={{ padding: 12, marginBottom: 12 }}>
                  <div style={{ fontWeight: 700 }}>LP status unknown</div>
                  <div className="small">Info only — does not affect score</div>
                  <ProofLinksInline signal={findSig("LP_STATUS_UNKNOWN")} />
                </div>
              )}

              {/* Deep loading banner (only if deep and no deep signals yet) */}
              {deepLoading && !hasAnyDeepSignal && (
                <div className="card" style={{ padding: 12, marginBottom: 12, opacity: 0.9 }}>
                  <div style={{ fontWeight: 700 }}>Deep checks in progress…</div>
                  <div className="small">TX patterns / contract checks are loading. Values will appear automatically.</div>
                </div>
              )}

              <div className="grid">
                {WHY_GROUPS.map(group => (
                  <div key={group.title} className="card" style={{ padding: 14 }}>
                    <div className="row" style={{ justifyContent: "space-between" }}>
                      <b>{group.title}</b>
                      <span className="small">{group.cap}</span>
                    </div>

                    <div style={{ height: 8 }} />

                    {group.rows.map(r => {
                      let triggered = false;
                      let label = r.label;
                      let pts = r.points;
                      let matchedSignal: any = null;
                      let isDeepRow = DEEP_IDS.includes(r.id);

                      if (r.id === "TOP10_DYNAMIC") {
                        const v = resolveTop10();
                        triggered = Boolean(v);
                        label = v ? `Top-10 token accounts > ${v.txt}` : "Top-10 token accounts > 40%";
                        pts = v ? v.pts : 5;
                        matchedSignal = v?.id ? findSig(v.id) : null;
                        isDeepRow = false;
                      } else if (r.id === "DEV_HOLDS_DYNAMIC") {
                        const v = resolveDevHolds();
                        triggered = Boolean(v);
                        label = v ? `Dev wallet holds > ${v.txt}` : "Dev wallet holds > 30%";
                        pts = v ? v.pts : 10;
                        matchedSignal = v?.id ? findSig(v.id) : null;
                        isDeepRow = false;
                      } else {
                        matchedSignal = findSig(r.id);
                        triggered = Boolean(matchedSignal);
                      }

                      // loading placeholder for deep rows
                      const showLoading = isDeepRow && deepLoading && !triggered;

                      return (
                        <div key={r.id} style={{ marginBottom: 10 }}>
                          <div className="row" style={{ justifyContent: "space-between" }}>
                            <span className="small">{label}</span>
                            <span style={{ fontWeight: 800 }}>
                              {triggered ? `+${pts}` : showLoading ? "Loading…" : "—"}
                            </span>
                          </div>

                          {/* Proof links only when triggered */}
                          {triggered && matchedSignal ? (
                            <ProofLinksInline signal={matchedSignal} />
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>

            {/* BOTTOM ROW: VERDICT / COMMUNITY / BREAKDOWN (as before) */}
            <div style={{ height: 14 }} />
            <div className="grid3">
              {/* VERDICT */}
              <div className="card">
                {(() => {
                  const vLevel = verdictFromScore(data.risk.score);
                  const v = VERDICT_COPY[vLevel];

                  const topSignals = pickSmartSignals({
                    signals: mergedSignals as any,
                    level: vLevel,
                    limit: 2,
                  });

                  const url = typeof window !== "undefined"
                    ? window.location.href
                    : "https://pump-guard-azure.vercel.app/";

                  const tweet = toTweetText({
                    chain: data.chain,
                    score: data.risk.score,
                    level: vLevel,
                    confidence: data.risk.confidence,
                    topSignals,
                    url,
                    tokenName: data.token?.name,
                    tokenSymbol: data.token?.symbol,
                    tokenAddress: data.token?.address,
                  });

                  return (
                    <>
                      <div className="row" style={{ justifyContent: "space-between" }}>
                        <b>VERDICT</b>
                        <RiskBadge level={vLevel} />
                      </div>

                      <div style={{ height: 8 }} />
                      <div style={{ fontWeight: 800 }}>{v.headline}</div>

                      <div style={{ height: 10 }} />
                      <div className="small" style={{ display: "grid", gap: 4 }}>
                        {v.bullets.map(t => <div key={t}>• {t}</div>)}
                      </div>

                      <div style={{ height: 10 }} />
                      <div className="small">
                        <b>Suggested action:</b> {v.action}
                      </div>

                      <div style={{ height: 12 }} />
                      <div className="row" style={{ gap: 10 }}>
                        <a className="btn btn-primary" href={makeXIntentUrl(tweet)} target="_blank" rel="noreferrer">
                          Share on X
                        </a>
                      </div>
                    </>
                  );
                })()}
              </div>

              {/* COMMUNITY */}
              <div className="card">
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <b>COMMUNITY FLAGS</b>
                  {target ? (
                    <span className="small">Target: {target.target_type} • {target.chain.toUpperCase()}</span>
                  ) : (
                    <span className="small">Target: —</span>
                  )}
                </div>

                <hr />

                {flagErr && (
                  <div className="small" style={{ marginBottom: 10 }}>
                    <b>Error:</b> {flagErr}
                  </div>
                )}

                <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
                  <div className="badge">🔴 RUGGED: <b>{flags?.rugged ?? 0}</b></div>
                  <div className="badge">🟡 SUS: <b>{flags?.sus ?? 0}</b></div>
                  <div className="badge">🟢 TRUSTED: <b>{flags?.trusted ?? 0}</b></div>
                </div>

                <div style={{ height: 10 }} />

                <input
                  className="input"
                  placeholder="Optional reason (e.g. dev dumped, LP pulled...)"
                  value={flagReason}
                  onChange={(e) => setFlagReason(e.target.value)}
                />

                <div style={{ height: 10 }} />

                <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
                  <button className="btn" disabled={!target || flagLoading !== ""} onClick={() => submitFlag("RUGGED")}>
                    {flagLoading === "RUGGED" ? "Voting..." : "Vote RUGGED"}
                  </button>
                  <button className="btn" disabled={!target || flagLoading !== ""} onClick={() => submitFlag("SUS")}>
                    {flagLoading === "SUS" ? "Voting..." : "Vote SUS"}
                  </button>
                  <button className="btn" disabled={!target || flagLoading !== ""} onClick={() => submitFlag("TRUSTED")}>
                    {flagLoading === "TRUSTED" ? "Voting..." : "Vote TRUSTED"}
                  </button>
                  <button className="btn" disabled={!target} onClick={fetchFlags}>Refresh</button>
                </div>

                <div style={{ height: 12 }} />
                <b>Recent activity</b>
                <div style={{ height: 8 }} />

                <div style={{ display: "grid", gap: 8 }}>
                  {(flags?.recent ?? []).slice(0, 6).map((r, idx) => (
                    <div key={`${r.ts}-${idx}`} className="card" style={{ padding: 12 }}>
                      <div className="row" style={{ justifyContent: "space-between" }}>
                        <div style={{ fontWeight: 800 }}>
                          {r.type === "RUGGED" ? "🔴 RUGGED" : r.type === "SUS" ? "🟡 SUS" : "🟢 TRUSTED"}
                        </div>
                        <div className="small" style={{ opacity: 0.8 }}>
                          {new Date(r.ts).toLocaleString()}
                        </div>
                      </div>
                      <div className="small" style={{ marginTop: 6, opacity: r.reason ? 1 : 0.7 }}>
                        {r.reason || "(no reason)"}
                      </div>
                    </div>
                  ))}

                  {(flags?.recent ?? []).length === 0 && (
                    <div className="small" style={{ opacity: 0.8 }}>No votes yet.</div>
                  )}
                </div>
              </div>

              {/* BREAKDOWN */}
              <div className="card">
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <b>RISK BREAKDOWN</b>
                  <span className="small">Max: 100</span>
                </div>

                <hr />

                {(() => {
                  const b = sumByCategory(mergedSignals as any);
                  const rows: { k: SignalCategory; v: number; cap: number }[] = (Object.keys(b) as SignalCategory[])
                    .map(k => ({ k, v: Math.round(b[k]), cap: CATEGORY_CAP[k] }));

                  return (
                    <div style={{ display: "grid", gap: 10 }}>
                      {rows.map(r => (
                        <div key={r.k} className="row" style={{ justifyContent: "space-between" }}>
                          <span className="small">{r.k}</span>
                          <b>{r.v} / {r.cap}</b>
                        </div>
                      ))}
                    </div>
                  );
                })()}
              </div>
            </div>
          </>
        )}
      </main>
    </>
  );
}
