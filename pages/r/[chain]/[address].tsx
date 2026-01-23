import { useRouter } from "next/router";
import { useEffect, useMemo, useState } from "react";
import type { ScoreResponse } from "../../../lib/types";

/* ================= UI helpers ================= */

function RiskBadge({ level }: { level: string }) {
  const emoji = level === "HIGH" ? "🔴" : level === "MEDIUM" ? "🟡" : "🟢";
  return <span className="badge">{emoji} {level}</span>;
}

type FlagsResp = {
  rugged: number;
  sus: number;
  trusted: number;
  recent: { type: "RUGGED" | "SUS" | "TRUSTED"; reason?: string; ts: string }[];
  note?: string;
  error?: string;
};

function categorizeSignalId(
  id: string
): "PERMISSIONS" | "DISTRIBUTION" | "DEV_BEHAVIOR" | "CONTEXT" | "OTHER" {
  if (id.includes("MINT_AUTHORITY") || id.includes("FREEZE_AUTHORITY")) return "PERMISSIONS";
  if (id.startsWith("TOP10_") || id.startsWith("DEV_TOP_HOLDER")) return "DISTRIBUTION";
  if (id.startsWith("DEV_EARLY_") || id.startsWith("HELIUS_")) return "DEV_BEHAVIOR";
  if (id.startsWith("TOKEN_AGE") || id.startsWith("DEV_CANDIDATE") || id === "DEV_UNKNOWN") return "CONTEXT";
  return "OTHER";
}

function sumByCategory(signals: { id: string; weight: number }[]) {
  const buckets: Record<string, number> = {
    PERMISSIONS: 0,
    DISTRIBUTION: 0,
    DEV_BEHAVIOR: 0,
    CONTEXT: 0,
    OTHER: 0,
  };
  for (const s of signals) {
    buckets[categorizeSignalId(s.id)] += s.weight || 0;
  }
  return buckets;
}

/* ================= Page ================= */

export default function ResultPage() {
  const router = useRouter();
  const { chain, address, type } = router.query as {
    chain?: string;
    address?: string;
    type?: string;
  };

  const [data, setData] = useState<ScoreResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const inputType: "token" | "wallet" =
    type === "wallet" ? "wallet" : "token";

  const apiUrl = useMemo(() => {
    if (!chain || !address) return "";
    const qs = new URLSearchParams({
      chain,
      input: address,
      type: inputType,
    });
    return `/api/score?${qs.toString()}`;
  }, [chain, address, inputType]);

  /* ---------- load data ---------- */

  useEffect(() => {
    if (!apiUrl) return;
    (async () => {
      setLoading(true);
      setError("");
      try {
        const res = await fetch(apiUrl);
        const j = await res.json();
        if (!res.ok) throw new Error(j?.error || "Failed");
        setData(j);
      } catch (e: any) {
        setError(e?.message || "Failed");
      } finally {
        setLoading(false);
      }
    })();
  }, [apiUrl]);

  /* ================= render ================= */

  return (
    <>
      {/* ================= NAV ================= */}
      <div className="nav">
        <div className="wrap nav-inner">
          <div className="brand">
            PUMP<span className="grad">.GUARD</span>{" "}
            <span className="small">Report</span>
          </div>
          <div className="small">
            Shareable report • Not financial advice.
          </div>
        </div>
      </div>

      {/* ================= CONTENT ================= */}
      <main className="wrap" style={{ padding: "22px 0 40px" }}>
        {/* header */}
        <div className="card">
          <div className="small">
            {inputType === "wallet" ? "Wallet" : "Token"}
          </div>
          <div style={{ fontWeight: 900, wordBreak: "break-all" }}>
            {address || "—"}
          </div>
          <div className="small">
            Chain: {(chain || "—").toUpperCase()}
          </div>
        </div>

        {loading && <div style={{ height: 14 }} />}
        {loading && <div className="card">Loading…</div>}

        {error && <div style={{ height: 14 }} />}
        {error && (
          <div className="card">
            <b>Error:</b> {error}
          </div>
        )}

        {/* ================= DATA ================= */}
        {data && (
          <>
            {/* quick summary */}
            <div style={{ height: 14 }} />
            <div className="card">
              <div style={{ fontWeight: 900, fontSize: 18 }}>
                Report quick summary
              </div>
              <hr />
              <div className="row" style={{ justifyContent: "space-between" }}>
                <div>
                  <div className="small">Risk score</div>
                  <div style={{ fontWeight: 900, fontSize: 28 }}>
                    {data.risk.score} / 100
                  </div>
                  <div className="small">
                    Confidence: {data.risk.confidence} • Mode: {data.risk.mode}
                  </div>
                </div>
                <RiskBadge level={data.risk.level} />
              </div>
            </div>

            {/* breakdown */}
            <div style={{ height: 14 }} />
            <div className="card">
              <div style={{ fontWeight: 900, fontSize: 18 }}>
                Risk breakdown
              </div>
              <hr />
              {Object.entries(sumByCategory(data.signals)).map(([k, v]) => (
                <div key={k} className="row">
                  <span>{k}</span>
                  <b>{Math.round(v)}</b>
                </div>
              ))}
            </div>

            {/* signals */}
            <div style={{ height: 14 }} />
            <div className="card">
              <div style={{ fontWeight: 900, fontSize: 18 }}>
                WHY (signals)
              </div>
              <hr />
              <div style={{ display: "grid", gap: 10 }}>
                {data.signals.map((s) => (
                  <div
                    key={s.id}
                    className="card"
                    style={{ padding: 12, boxShadow: "none" }}
                  >
                    <div style={{ fontWeight: 800 }}>{s.label}</div>
                    <div className="small">
                      Weight: <b>{s.weight}</b>
                      {s.value ? ` • ${s.value}` : ""}
                    </div>
                    {Array.isArray(s.proof) && s.proof.length > 0 && (
                      <div className="small">
                        <a
                          href={s.proof[0]}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Proof
                        </a>
                      </div>
                    )}
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
