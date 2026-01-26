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
   WHY model (11 criteria)
   ========================= */

type WhyRow = {
  id: string;
  label: string;
  points: number;
};

const WHY_GROUPS: {
  title: string;
  cap: number;
  rows: WhyRow[];
}[] = [
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
    title: "LIQUIDITY (LP)",
    cap: 10,
    rows: [
      { id: "LP_NOT_BURNED", label: "LP not burned / unlocked", points: 10 },
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
    title: "TX PATTERNS",
    cap: 20,
    rows: [
      { id: "DEV_DUMP_EARLY", label: "Dev dumps shortly after launch", points: 10 },
      { id: "BUNDLED_LAUNCH_OR_MEV", label: "Bundled launch / sniper / MEV", points: 5 },
      { id: "CLUSTER_FUNDING", label: "Cluster funding", points: 5 },
    ],
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

  /* =========================
     Helpers for dynamic rows
     ========================= */

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
                        if (v) { label = `Top-10 holders > ${v.txt}`; pts = v.pts; }
                      } else if (r.id === "DEV_HOLDS_DYNAMIC") {
                        const v = resolveDevHolds();
                        triggered = Boolean(v);
                        if (v) { label = `Dev wallet holds > ${v.txt}`; pts = v.pts; }
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
          </>
        )}
      </main>
    </>
  );
}
