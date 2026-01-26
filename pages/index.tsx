import { useMemo, useState } from "react";
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
   WHY criteria (fixed model)
   ========================= */

const WHY_CRITERIA = [
  // PERMISSIONS
  { id: "MINT_AUTHORITY_PRESENT", label: "Mint authority present", points: 5 },
  { id: "FREEZE_AUTHORITY_PRESENT", label: "Freeze authority present", points: 5 },

  // DISTRIBUTION (mutually exclusive)
  { id: "TOP10_GT_80", label: "Top-10 holders > 80%", points: 15 },
  { id: "TOP10_GT_60", label: "Top-10 holders > 60%", points: 10 },
  { id: "TOP10_GT_40", label: "Top-10 holders > 40%", points: 5 },

  // LIQUIDITY
  { id: "LP_NOT_BURNED", label: "LP not burned / unlocked", points: 10 },

  // DEV / CONTRACT
  { id: "BLACKLIST_OR_TRANSFER_BLOCK", label: "Blacklist / transfer blocking", points: 15 },
  { id: "HIGH_TAX", label: "High buy/sell tax", points: 10 },
  { id: "NONSTANDARD_TRANSFER", label: "Non-standard transfer logic / hooks", points: 5 },

  // TX PATTERNS
  { id: "DEV_DUMP_EARLY", label: "Dev dumps shortly after launch", points: 10 },
  { id: "BUNDLED_LAUNCH_OR_MEV", label: "Bundled launch / sniper / MEV", points: 5 },
  { id: "CLUSTER_FUNDING", label: "Cluster funding", points: 5 },
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

  async function run() {
    setLoading(true);
    setError("");
    setData(null);

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

  return (
    <>
      {/* NAV */}
      <div className="nav">
        <div className="wrap nav-inner">
          <div className="brand">
            PUMP<span className="grad">.GUARD</span> <span className="small">MVP</span>
          </div>
          <div className="small">Not financial advice. Just signals.</div>
        </div>
      </div>

      <main className="wrap" style={{ padding: "22px 0 40px" }}>

        {/* TOP ROW */}
        <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 14 }}>

          {/* LEFT — INPUT */}
          <div className="card">
            <h1 style={{ margin: "0 0 8px" }}>Check the risk before you buy</h1>
            <div className="small">
              Paste a token contract or dev wallet. Chain auto-detect supported.
            </div>

            <div style={{ height: 12 }} />

            <input
              className="input"
              placeholder="Token address (SOL / 0x...) or wallet"
              value={input}
              onChange={(e) => setInput(e.target.value)}
            />

            <div style={{ height: 12 }} />

            <div className="row">
              <label className="small">Chain:</label>
              <select className="input" value={chain} onChange={(e) => setChain(e.target.value as any)}>
                <option value="auto">auto (detected: {detected})</option>
                <option value="sol">sol</option>
                <option value="eth">eth</option>
                <option value="bnb">bnb</option>
              </select>

              <label className="small">Type:</label>
              <select className="input" value={type} onChange={(e) => setType(e.target.value as any)}>
                <option value="token">token</option>
                <option value="wallet">wallet</option>
              </select>

              <button className="btn btn-primary" disabled={!input || loading} onClick={run}>
                {loading ? "Checking..." : "Check risk"}
              </button>
            </div>
          </div>

          {/* RIGHT — RISK + CONTEXT */}
          <div className="card">
            <div className="small">Chain</div>
            <div style={{ fontWeight: 900, fontSize: 18 }}>
              {data ? data.chain.toUpperCase() : "—"}
            </div>

            <hr />

            <div className="small">Risk score</div>
            <div style={{ fontWeight: 900, fontSize: 28 }}>
              {data ? `${data.risk.score} / 100` : "0 / 100"}
            </div>

            <div style={{ marginTop: 6 }}>
              <RiskBadge level={data?.risk.level ?? "LOW"} />
            </div>

            <hr />

            <div className="small">Dev wallet</div>
            <div style={{ wordBreak: "break-all" }}>
              {data?.dev?.address ?? "—"}
            </div>

            <div style={{ height: 8 }} />

            <div className="small">Token age</div>
            <div>{formatAge(data?.token?.age_seconds)}</div>

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

        {/* WHY — FULL WIDTH */}
        {data && (
          <>
            <div style={{ height: 14 }} />
            <div className="card">
              <div style={{ fontWeight: 900 }}>WHY (signals)</div>
              <div className="small">These checks may affect the score</div>
              <hr />

              {/* LP unknown info (Variant A) */}
              {data.signals?.some(s => s.id === "LP_STATUS_UNKNOWN") && (
                <div className="card" style={{ padding: 12, marginBottom: 12 }}>
                  <div style={{ fontWeight: 700 }}>LP status unknown</div>
                  <div className="small">Info only — does not affect score</div>
                </div>
              )}

              <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                {WHY_CRITERIA.map((c) => {
                  const hit = data.signals?.find(s => s.id === c.id);
                  return (
                    <div key={c.id} className="row" style={{ justifyContent: "space-between" }}>
                      <div>
                        <div style={{ fontWeight: 700 }}>{c.label}</div>
                        <div className="small" style={{ opacity: 0.7 }}>
                          {hit ? "Triggered" : "Not triggered"}
                        </div>
                      </div>
                      <div style={{ fontWeight: 900 }}>
                        {hit ? `+${c.points}` : "—"}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )}

      </main>
    </>
  );
}
