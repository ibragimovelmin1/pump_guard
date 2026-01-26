export type Chain = "sol" | "eth" | "bnb";
export type ChainAuto = Chain | "auto";
export type InputType = "token" | "wallet";
export type RiskLevel = "LOW" | "MEDIUM" | "HIGH";
export type Confidence = "LOW" | "MED" | "HIGH";


export type TopHolder = {
  rank: number;
  owner: string;
  token_account: string;
  percent: number;
  ui_amount: number;
  tag?: "DEV" | "LP" | "EARLY" | "UNKNOWN";
};

export type DevHistory = {
  launches_est: number;
  helius_sampled_mints: number;
  candidate_mints_checked: number;
  early_dump_count: number;
  early_dump_rate: number; // 0-1
  died_lt_24h: number; // heuristic among checked mints
  median_first_out_min: number | null; // minutes (heuristic)
  suspected_rugs: number; // heuristic among checked mints
  notes?: string[];
};
export type Signal = {
  id: string;
  label: string;
  value?: string;
  weight: number;
  proof?: string[];
};

export type ScoreResponse = {
  chain: Chain;
  input_type: InputType;
  token?: { address: string; name?: string; symbol?: string; age_seconds?: number; holders?: number; top10_percent?: number; top_holders?: TopHolder[]; links?: { explorer: string } };
  dev?: { address: string; links?: { explorer: string } };
  dev_history?: DevHistory;
  risk: { score: number; level: RiskLevel; confidence: Confidence; mode: "DEMO" | "LIVE" };
  signals: Signal[];
  community?: { rugged: number; sus: number; trusted: number; recent: { type:"RUGGED"|"SUS"|"TRUSTED"; reason?: string; ts: string }[] };
};
