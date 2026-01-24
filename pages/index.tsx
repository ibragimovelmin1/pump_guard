import { useMemo, useState, useEffect } from "react";
import type { ChainAuto, ScoreResponse } from "../lib/types";
import { detectChain } from "../lib/detect";

/* =========================
   UI helpers
   ========================= */

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

/* =========================
   Signal categorization
   ========================= */

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
  /* =========================
   Verdict + Share helpers
   ========================= */

type VerdictLevel = "LOW" | "MEDIUM" | "HIGH";

function verdictFromScore(score: number): VerdictLevel {
  if (score >= 67) return "HIGH";
  if (score >= 34) return "MEDIUM";
  return "LOW";
}

const VERDICT_COPY: Record<
  VerdictLevel,
  { headline: string; bullets: string[]; action: string }
> = {
  LOW: {
    headline: "Low risk signals detected",
    bullets: [
      "No critical red flags detected in current on-chain signals.",
      "Token is very new — volatility is likely high.",
      "Always manage position size and exit plan.",
    ],
    action: "Suitable for quick pre-entry checks. Still not risk-free.",
  },
  MEDIUM: {
    headline: "Moderate risk signals detected",
    bullets: [
      "Some on-chain risk signals are present.",
      "Potential concerns require manual review.",
      "Higher uncertainty compared to low-risk setups.",
    ],
    action: "Consider smaller size and faster invalidation.",
  },
  HIGH: {
    headline: "High risk signals detected",
    bullets: [
      "Multiple red flags detected in on-chain behavior.",
      "High probability of unfavorable outcomes.",
      "Historical patterns resemble common rug scenarios.",
    ],
    action: "Avoid or treat as extremely high risk.",
  },
};

function toTweetText(args: {
  chain: string;
  score: number;
  level: VerdictLevel;
  confidence?: string;
  mode?: string;
  topSignals: string[];
  url: string;
}) {
  const emoji = args.level === "HIGH" ? "🔴" : args.level === "MEDIUM" ? "🟡" : "🟢";
  const signalsLine =
    args.topSignals.length > 0 ? `\nSignals: ${args.topSignals.join(" • ")}` : "";

  return (
    `Checked with PUMP.GUARD\n\n` +
    `${emoji} Risk score: ${args.score} / 100 (${args.level})\n` +
    `Chain: ${args.chain.toUpperCase()}\n` +
    (args.confidence ? `Confidence: ${args.confidence}\n` : "") +
    (args.mode ? `Mode: ${args.mode}\n` : "") +
    `${signalsLine}\n\n` +
    `Not financial advice. Just signals.\n` +
    `${args.url}`
  );
}

function makeXIntentUrl(text: string) {
  return `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`;
}
  for (const s of signals) {
    buckets[categorizeSignalId(s.id)] += s.weight || 0;
  }
  return buckets;
}
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

  /* ---------- Community flags ---------- */

  const [flags, setFlags] = useState<FlagsResp | null>(null);
  const [flagReason, setFlagReason] = useState("");
  const [flagLoading, setFlagLoading] =
    useState<"RUGGED" | "SUS" | "TRUSTED" | "">("");
  const [flagErr, setFlagErr] = useState("");

  const target = useMemo(() => {
    if (!data) return null;
    const target_type = data.input_type === "token" ? "token" : "dev";
    const target_address =
      data.input_type === "token" ? data.token?.address : data.dev?.address;
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

  useEffect(() => {
    if (target) fetchFlags();
    else setFlags(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.chain, target?.target_type, target?.target_address]);

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

  /* =========================
     Render
     ========================= */

  return (
    <>
      <div className="nav">
        <div className="wrap nav-inner">
          <div className="brand">
            PUMP<span className="grad">.GUARD</span>{" "}
            <span className="small">MVP</span>
          </div>
          <div className="small">Not financial advice. Just signals.</div>
        </div>
      </div>

      <main className="wrap" style={{ padding: "22px 0 40px" }}>
        {/* ---------- Input ---------- */}
        <div className="card">
          <h1 style={{ margin: "0 0 8px" }}>Check the risk before you buy</h1>
          <div className="small">
            Paste a token (SOL mint / 0x contract) or a dev wallet. Chain
            auto-detect is supported.
          </div>

          <div style={{ height: 12 }} />

          <input
            className="input"
            placeholder="Token address (SOL mint / 0x...) or wallet"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />

          <div style={{ height: 12 }} />

          <div className="row">
            <label className="small">Chain:</label>
            <select
              className="input"
              value={chain}
              onChange={(e) => setChain(e.target.value as any)}
            >
              <option value="auto">auto (detected: {detected})</option>
              <option value="sol">sol</option>
              <option value="eth">eth</option>
              <option value="bnb">bnb</option>
            </select>

            <label className="small">Type:</label>
            <select
              className="input"
              value={type}
              onChange={(e) => setType(e.target.value as any)}
            >
              <option value="token">token</option>
              <option value="wallet">wallet</option>
            </select>

            <button
              className="btn btn-primary"
              disabled={!input || loading}
              onClick={run}
            >
              {loading ? "Checking..." : "Check risk"}
            </button>
          </div>
        </div>

        {/* ---------- Error ---------- */}
        {error && (
          <div className="card" style={{ marginTop: 14 }}>
            <b>Error:</b> {error}
          </div>
        )}

        {/* ---------- Result ---------- */}
        {data && (
          <>
            <div style={{ height: 14 }} />

            <div className="grid">
              <div className="card">
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <div>
                    <div className="small">Chain</div>
                    <div style={{ fontWeight: 900, fontSize: 18 }}>
                      {data.chain.toUpperCase()}
                    </div>
                  </div>
                  <RiskBadge level={data.risk.level} />
                </div>
</div>
                <hr />

                <div className="row" style={{ justifyContent: "space-between" }}>
                  <div>
                    <div className="small">Risk score</div>
                    <div style={{ fontWeight: 900, fontSize: 28 }}>
                      {data.risk.score} / 100
                    </div>
                  </div>
                  <div>
                    <div className="small">Confidence</div>
                    <div style={{ fontWeight: 900 }}>
                      {data.risk.confidence}
                    </div>
                    <div className="small">Mode: {data.risk.mode}</div>
                  </div>
                </div>
              </div>

              
              <div className="card">
                <div style={{ fontWeight: 900 }}>WHY (signals)</div>
                <hr />
                <div style={{ display: "grid", gap: 10 }}>
                  {data.signals.map((s) => (
                    <div key={s.id} className="card" style={{ padding: 12 }}>
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
                            Proof link
                          </a>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
<div className="card">
{(() => {
const vLevel = verdictFromScore(data.risk.score);
const v = VERDICT_COPY[vLevel];

const topSignals = [...data.signals]
.sort((a, b) => (b.weight || 0) - (a.weight || 0))
.slice(0, 2)
.map((s) => s.label);
const url =
typeof window !== "undefined"

? window.location.href
: "https://pump-guard-azure.vercel.app/";
const tweet = toTweetText({
chain: data.chain,

score: data.risk.score,
level: vLevel,
confidence: data.risk.confidence,
mode: data.risk.mode,
topSignals,
url,
});
return (
<>

<hr />
<div style={{ fontWeight: 900, marginBottom: 6 }}>VERDICT</div>
<div style={{ fontWeight: 800 }}>{v.headline}</div>
<div style={{ height: 8 }} />
<div className="small" style={{ display: "grid", gap: 4 }}>

{v.bullets.map((t) => (
<div key={t}>• {t}</div>
))}
</div>
<div style={{ height: 10 }} />
<div className="small">

<b>Suggested action:</b> {v.action}
</div>
<div style={{ height: 12 }} />
<div className="row" style={{ gap: 10 }}>

<a
className="btn btn-primary"
href={makeXIntentUrl(tweet)}
target="_blank"
rel="noreferrer"
>
Share on X
</a>
<div className="small" style={{ opacity: 0.8 }}>
You control what you share.
</div>
</div>
</>
);
})()}
</div>{(() => {
const vLevel = verdictFromScore(data.risk.score);
const v = VERDICT_COPY[vLevel];

const topSignals = [...data.signals]
.sort((a, b) => (b.weight || 0) - (a.weight || 0))
.slice(0, 2)
.map((s) => s.label);
const url =
typeof window !== "undefined"

? window.location.href
: "https://pump-guard-azure.vercel.app/";
const tweet = toTweetText({
chain: data.chain,

score: data.risk.score,
level: vLevel,
confidence: data.risk.confidence,
mode: data.risk.mode,
topSignals,
url,
});
return (
<>

<hr />
<div style={{ fontWeight: 900, marginBottom: 6 }}>VERDICT</div>
<div style={{ fontWeight: 800 }}>{v.headline}</div>
<div style={{ height: 8 }} />
<div className="small" style={{ display: "grid", gap: 4 }}>

{v.bullets.map((t) => (
<div key={t}>• {t}</div>
))}
</div>
<div style={{ height: 10 }} />
<div className="small">

<b>Suggested action:</b> {v.action}
</div>
<div style={{ height: 12 }} />
<div className="row" style={{ gap: 10 }}>

<a
className="btn btn-primary"
href={makeXIntentUrl(tweet)}
target="_blank"
rel="noreferrer"
>
Share on X
</a>
<div className="small" style={{ opacity: 0.8 }}>
You control what you share.
</div>
</div>
</>
);
})()}
            {/* ---------- Breakdown ---------- */}
            <div style={{ height: 14 }} />
            <div className="card">
              <b>Risk breakdown</b>
              <hr />
              {Object.entries(sumByCategory(data.signals)).map(
                ([k, v]) => (
                  <div key={k} className="row">
                    <span>{k}</span>
                    <b>{Math.round(v)}</b>
                  </div>
                )
              )}
            </div>
          </>
        )}
      </main>
    </>
  );
}
