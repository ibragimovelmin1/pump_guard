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

// confidence = trust → зелёный = хорошо
function ConfidenceBadge({ level }: { level: RiskLevel | string }) {
  const emoji = level === "HIGH" ? "🟢" : level === "MEDIUM" ? "🟡" : "🔴";
  return <span className="badge">{emoji} {String(level)}</span>;
}

function formatAge(sec?: number) {
  if (sec === undefined) return "—";
  if (sec < 60) return "<1m";
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

function formatHolders(v?: number) {
  if (typeof v === "number") return v.toLocaleString();
  return "—";
}

/* =========================
   Proof links
   ========================= */

function getProofLinks(signal: any) {
  if (Array.isArray(signal?.proofLinks)) return signal.proofLinks;
  if (Array.isArray(signal?.proof)) {
    return signal.proof.map((url: string) => {
      let label = "Proof";
      if (url.includes("solscan")) label = "Solscan";
      if (url.includes("solana.fm")) label = "SolanaFM";
      if (url.includes("birdeye")) label = "Birdeye";
      if (url.includes("dexscreener")) label = "Dexscreener";
      return { label, url };
    });
  }
  return [];
}

function ProofLinks({ signal }: { signal: any }) {
  const links = getProofLinks(signal);
  if (!links.length) return null;

  return (
    <div className="row" style={{ gap: 10, flexWrap: "wrap", justifyContent: "flex-end", marginTop: 4 }}>
      {links.map((l: any) => (
        <a
          key={l.url}
          href={l.url}
          target="_blank"
          rel="noreferrer"
          className="small"
          style={{ textDecoration: "underline", opacity: 0.8 }}
        >
          {l.label}
        </a>
      ))}
    </div>
  );
}

/* =========================
   Merge signals
   ========================= */

function mergeSignals(base: Signal[], deep: Signal[]) {
  const map = new Map<string, Signal>();
  base.forEach(s => map.set(s.id, s));
  deep.forEach(s => map.set(s.id, s)); // deep перезаписывает base
  return Array.from(map.values());
}

/* =========================
   Page
   ========================= */

export default function Home() {
  const [input, setInput] = useState("");
  const [chain, setChain] = useState<ChainAuto>("auto");

  const [loading, setLoading] = useState(false);
  const [deepLoading, setDeepLoading] = useState(false);

  const [data, setData] = useState<ScoreResponse | null>(null);
  const [deepSignals, setDeepSignals] = useState<Signal[]>([]);
  const [error, setError] = useState("");

  const detected = useMemo(() => detectChain(input) ?? "—", [input]);

  /* =========================
     Main run
     ========================= */

  async function run() {
    setLoading(true);
    setDeepLoading(true);
    setError("");
    setData(null);
    setDeepSignals([]);

    try {
      // FAST
      const qs = new URLSearchParams({ input, chain, type: "token" });
      const res = await fetch(`/api/score?${qs.toString()}`);
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error || "score failed");
      setData(j);

      // DEEP (fire & forget)
      fetch(`/api/score_deep?chain=sol&input=${input}`)
        .then(r => r.json())
        .then(j => {
          if (Array.isArray(j?.signals)) {
            setDeepSignals(j.signals);
          }
        })
        .catch(() => {})
        .finally(() => setDeepLoading(false));
    } catch (e: any) {
      setError(e?.message || "Unknown error");
      setDeepLoading(false);
    } finally {
      setLoading(false);
    }
  }

  const allSignals = useMemo(() => {
    if (!data) return [];
    return mergeSignals(data.signals ?? [], deepSignals);
  }, [data?.signals, deepSignals]);

  /* =========================
     Render
     ========================= */

  return (
    <>
      <div className="nav">
        <div className="wrap nav-inner">
          <div className="brand">PUMP<span className="grad">.GUARD</span></div>
          <div className="small">MVP — on-chain risk signals</div>
        </div>
      </div>

      <main className="wrap" style={{ padding: "22px 0 40px" }}>
        {/* INPUT */}
        <div className="card">
          <input
            className="input"
            placeholder="Token address"
            value={input}
            onChange={e => setInput(e.target.value)}
          />
          <div className="row" style={{ marginTop: 10 }}>
            <select className="input" value={chain} onChange={e => setChain(e.target.value as any)}>
              <option value="auto">auto ({detected})</option>
              <option value="sol">sol</option>
            </select>
            <button className="btn btn-primary" disabled={!input || loading} onClick={run}>
              {loading ? "Checking..." : "Check risk"}
            </button>
          </div>
        </div>

        {/* ERROR */}
        {error && <div className="card"><b>Error:</b> {error}</div>}

        {/* RESULT */}
        {data && (
          <>
            <div className="card">
              <div className="row" style={{ justifyContent: "space-between" }}>
                <b>{data.token?.name || data.token?.symbol || "Token"}</b>
                <b>{data.risk.score} / 100</b>
              </div>

              <div className="row" style={{ gap: 12, marginTop: 8 }}>
                <div>
                  <div className="small">Risk</div>
                  <RiskBadge level={data.risk.level} />
                </div>
                <div>
                  <div className="small">Confidence</div>
                  <ConfidenceBadge level={data.risk.confidence} />
                </div>
              </div>

              <div style={{ marginTop: 10 }}>
                <div className="small">Age</div>
                {formatAge(data.token?.age_seconds)}
              </div>

              <div>
                <div className="small">Holders</div>
                {formatHolders(data.token?.holders)}
              </div>
            </div>

            {/* WHY */}
            <div className="card">
              <b>WHY (signals)</b>
              <div className="small">
                {deepLoading ? "Deep analysis in progress…" : "Complete"}
              </div>

              <hr />

              {allSignals.map(s => (
                <div key={s.id} className="card" style={{ padding: 10, marginBottom: 8 }}>
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <div>
                      <b>{s.label}</b>
                      {s.value && <div className="small">{s.value}</div>}
                    </div>
                    <div style={{ fontWeight: 800 }}>+{s.weight}</div>
                  </div>
                  <ProofLinks signal={s} />
                </div>
              ))}

              {deepLoading && (
                <div className="small" style={{ opacity: 0.7 }}>
                  Loading TX patterns / LP / contract checks…
                </div>
              )}
            </div>
          </>
        )}
      </main>
    </>
  );
}
