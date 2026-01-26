import { useMemo, useState, useEffect } from "react";
import type { ChainAuto, ScoreResponse } from "../lib/types";
import { detectChain } from "../lib/detect";

/* =========================
   Helpers
   ========================= */

type RiskLevel = "LOW" | "MEDIUM" | "HIGH";

function RiskBadge({ level }: { level: RiskLevel | string }) {
  const emoji = level === "HIGH" ? "🔴" : level === "MEDIUM" ? "🟡" : "🟢";
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

  return (
    `Checked with PUMP.GUARD\n\n` +
    `${emoji} ${title}\n` +
    `Risk: ${args.score} / 100 (${args.level})\n` +
    `Chain: ${args.chain.toUpperCase()}\n` +
    (args.confidence ? `Confidence: ${args.confidence}\n` : "") +
    `${signalsBlock}\n\n` +
    contractBlock +
`\nNot financial advice.\n` +
`${args.url}`
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

  // PERMISSIONS
  if (x.includes("MINT_AUTHORITY") || x.includes("FREEZE_AUTHORITY")) return "PERMISSIONS";

  // DISTRIBUTION
  if (x.startsWith("TOP10_") || x.startsWith("DEV_HOLDS_")) return "DISTRIBUTION";

  // LIQUIDITY
  if (x.startsWith("LP_")) return "LIQUIDITY";

  // DEV / CONTRACT
  if (
    x.includes("BLACKLIST") ||
    x.includes("TRANSFER_BLOCK") ||
    x.includes("HIGH_TAX") ||
    x.includes("NONSTANDARD_TRANSFER") ||
    x.includes("HOOK")
  ) return "DEV_CONTRACT";

  // TX PATTERNS
  if (x.includes("DEV_DUMP") || x.includes("BUNDLED") || x.includes("MEV") || x.includes("CLUSTER")) return "TX_PATTERNS";

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

  // Clamp to caps (important)
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
      { id: "TOP10_DYNAMIC", label: "Top-10 holders >", points: 0 }, // dynamic 40/60/80
      { id: "DEV_HOLDS_DYNAMIC", label: "Dev wallet holds >", points: 0 }, // dynamic 30/50
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
  const [data, setData] = useState<ScoreResponse | null>(null);
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
    setLoading(true);
    setError("");
    setData(null);
    setFlags(null);

    try {
      const qs = new URLSearchParams({ input, chain, type });
      const res = await fetch(`/api/score?${qs.toString()}`);
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error || "Request failed");
      setData(j);
    } catch (e: any) {
      setError(e?.message || "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  /* ---------- Dynamic rows ---------- */
  function resolveTop10() {
    if (!data) return null;
    if (data.signals.find(s => s.id === "TOP10_GT_80")) return { txt: "80%", pts: 15 };
    if (data.signals.find(s => s.id === "TOP10_GT_60")) return { txt: "60%", pts: 10 };
    if (data.signals.find(s => s.id === "TOP10_GT_40")) return { txt: "40%", pts: 5 };
    return null;
  }

  function resolveDevHolds() {
    if (!data) return null;
    if (data.signals.find(s => s.id === "DEV_HOLDS_GT_50")) return { txt: "50%", pts: 15 };
    if (data.signals.find(s => s.id === "DEV_HOLDS_GT_30")) return { txt: "30%", pts: 10 };
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

            <div style={{ marginTop: 10 }}>
              <RiskBadge level={data?.risk.level ?? "LOW"} />
            </div>

            <div className="small" style={{ opacity: 0.6, marginTop: 8 }}>
              Info only — does not affect score
            </div>
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

              {data.signals?.some(s => s.id === "LP_STATUS_UNKNOWN") && (
                <div className="card" style={{ padding: 12, marginBottom: 12 }}>
                  <div style={{ fontWeight: 700 }}>LP status unknown</div>
                  <div className="small">Info only — does not affect score</div>
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

                      if (r.id === "TOP10_DYNAMIC") {
                        const v = resolveTop10();
                        triggered = Boolean(v);
                        label = v ? `Top-10 holders > ${v.txt}` : "Top-10 holders > 40%";
                        pts = v ? v.pts : 5;
                      } else if (r.id === "DEV_HOLDS_DYNAMIC") {
                        const v = resolveDevHolds();
                        triggered = Boolean(v);
                        label = v ? `Dev wallet holds > ${v.txt}` : "Dev wallet holds > 30%";
                        pts = v ? v.pts : 10;
                      } else {
                        triggered = Boolean(data.signals.find(s => s.id === r.id));
                      }

                      return (
                        <div key={r.id} className="row" style={{ justifyContent: "space-between" }}>
                          <span className="small">{label}</span>
                          <span style={{ fontWeight: 800 }}>
                            {triggered ? `+${pts}` : "—"}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>

            {/* BOTTOM ROW: VERDICT / COMMUNITY / BREAKDOWN */}
            <div style={{ height: 14 }} />
            <div className="grid3">
              {/* VERDICT */}
              <div className="card">
                {(() => {
                  const vLevel = verdictFromScore(data.risk.score);
                  const v = VERDICT_COPY[vLevel];

                  const topSignals = [...(data.signals ?? [])]
                    .filter(s => (Number(s.weight ?? 0) || 0) > 0)
                    .sort((a, b) => (Number(b.weight ?? 0) || 0) - (Number(a.weight ?? 0) || 0))
                    .slice(0, 2)
                    .map(s => s.label);

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
                  const b = sumByCategory(data.signals ?? []);
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
