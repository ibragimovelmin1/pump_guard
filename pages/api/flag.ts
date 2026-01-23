import type { NextApiRequest, NextApiResponse } from "next";
import crypto from "crypto";
import { getSupabaseAdmin } from "../../lib/supabaseAdmin";
import type { Chain } from "../../lib/types";

function fingerprint(req: NextApiRequest): string {
  const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
  const ua = req.headers["user-agent"] || "unknown";
  const salt = process.env.FP_SALT || "pumpguard_salt_v0";
  return crypto.createHash("sha256").update(`${ip}|${ua}|${salt}`).digest("hex");
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { chain, target_type, target_address, flag_type, reason } = req.body || {};
  if (!chain || !target_type || !target_address || !flag_type) return res.status(400).json({ error: "Missing required fields" });

  const sb = getSupabaseAdmin();
  if (!sb) return res.status(400).json({ error: "Supabase not configured" });

  const fp = fingerprint(req);
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data: existing, error: e1 } = await sb
    .from("flags")
    .select("id")
    .eq("chain", chain as Chain)
    .eq("target_type", target_type)
    .eq("target_address", target_address)
    .eq("fingerprint_hash", fp)
    .gte("created_at", since)
    .limit(1);

  if (e1) return res.status(500).json({ error: e1.message });
  if (existing && existing.length > 0) return res.status(429).json({ error: "Rate limit: one flag per day for this target" });

  const cleanReason = typeof reason === "string" ? reason.slice(0, 240) : "";
  const { error } = await sb.from("flags").insert({ chain, target_type, target_address, flag_type, reason: cleanReason, fingerprint_hash: fp });
  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json({ ok: true });
}
