import type { Chain } from "./types";

export function explorerAddress(chain: Chain, address: string): string {
  if (chain === "sol") return `https://solscan.io/account/${address}`;
  if (chain === "eth") return `https://etherscan.io/address/${address}`;
  return `https://bscscan.com/address/${address}`;
}
export function explorerToken(chain: Chain, token: string): string {
  if (chain === "sol") return `https://solscan.io/token/${token}`;
  if (chain === "eth") return `https://etherscan.io/token/${token}`;
  return `https://bscscan.com/token/${token}`;
}
