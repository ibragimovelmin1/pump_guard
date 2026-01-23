import type { NextApiRequest, NextApiResponse } from "next";
import { getSupabaseAdmin } from "../../lib/supabaseAdmin";
import type { Chain } from "../../lib/types";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const chain = (req.query.chain as Chain) || "sol";
  const target_type = (req.query.target_type as string) || "token";
  const target_address = (req.query.target_address as string) || "";
  if (!target_address) return res.status(400).json({ error: "Missing target_address" });

  const sb = getSupabaseAdmin();
  if (!sb) return res.status(200).json({ rugged: 0, sus: 0, trusted: 0, recent: [], note: "Supabase not configured" });

  const { data, error } = await sb
    .from("flags")
    .select("flag_type, reason, created_at")
    .eq("chain", chain)
    .eq("target_type", target_type)
    .eq("target_address", target_address)
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) return res.status(500).json({ error: error.message });

  const recent = (data ?? []).map((r: any) => ({ type: r.flag_type, reason: r.reason ?? "", ts: r.created_at }));
  const count = (t: string) => (data ?? []).filter((r: any) => r.flag_type === t).length;

  return res.status(200).json({ rugged: count("RUGGED"), sus: count("SUS"), trusted: count("TRUSTED"), recent });
}
