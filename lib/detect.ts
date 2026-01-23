import type { Chain, ChainAuto } from "./types";

export function detectChain(input: string): Chain | null {
  const s = input.trim();
  if (/^0x[a-fA-F0-9]{40}$/.test(s)) return "eth"; // default EVM to eth unless user chooses bnb
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return "sol";
  return null;
}

export function normalizeChain(chain: ChainAuto, input: string): Chain {
  if (chain === "auto") return detectChain(input) ?? "sol";
  return chain;
}
