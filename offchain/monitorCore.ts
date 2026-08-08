import { ethers } from "ethers";

/**
 * Read-only invariant checks for the bridge monitor.
 *
 * Two classes of check:
 *  - LOCAL (one chain): the on-chain contracts can verify these themselves
 *    via checkNativeInvariant/checkWrappedInvariant; the monitor evaluates
 *    them off-chain first (free) and only spends gas when a violation is
 *    real.
 *  - CROSS-CHAIN (two chains): wrapped supply minted on the destination must
 *    never exceed native locked on the source. NO contract can see this,
 *    because neither chain can read the other; this daemon is the only
 *    enforcement point, which is why SECURITY.md requires it to run
 *    continuously.
 *
 * Kept free of config/daemon concerns so the checks can be tested directly
 * against contracts.
 */

export const MONITOR_BRIDGE_ABI = [
  "function tokenType(address) view returns (uint8)",
  "function lockedBalance(address) view returns (uint256)",
  "function mintedSupply(address) view returns (uint256)",
  "function paused() view returns (bool)",
  "function registry() view returns (address)",
  "function checkNativeInvariant(address)",
  "function checkWrappedInvariant(address)",
  "function votePause()",
];

export const ERC20_VIEW_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
];

export type TokenKind = "None" | "Native" | "Wrapped";

export interface InvariantStatus {
  token: string;
  kind: TokenKind;
  /** What the bridge's books say must be backed. */
  expected: bigint;
  /** What actually exists on-chain. */
  actual: bigint;
  violated: boolean;
}

/**
 * Local invariant for one token on one chain.
 *  - Native: the bridge's token balance must cover `lockedBalance`.
 *  - Wrapped: `totalSupply` must not exceed `mintedSupply` (users may burn
 *    directly, shrinking supply, which is harmless; excess supply means a
 *    mint happened outside the quorum path).
 */
export async function checkTokenInvariant(
  runner: ethers.ContractRunner,
  bridgeAddress: string,
  token: string
): Promise<InvariantStatus> {
  const bridge = new ethers.Contract(bridgeAddress, MONITOR_BRIDGE_ABI, runner);
  const kind = Number(await bridge.tokenType(token));
  if (kind === 1) {
    const expected: bigint = await bridge.lockedBalance(token);
    const actual: bigint = await new ethers.Contract(token, ERC20_VIEW_ABI, runner).balanceOf(
      bridgeAddress
    );
    return { token, kind: "Native", expected, actual, violated: actual < expected };
  }
  if (kind === 2) {
    const expected: bigint = await bridge.mintedSupply(token);
    const actual: bigint = await new ethers.Contract(token, ERC20_VIEW_ABI, runner).totalSupply();
    return { token, kind: "Wrapped", expected, actual, violated: actual > expected };
  }
  return { token, kind: "None", expected: 0n, actual: 0n, violated: false };
}

export interface PairStatus {
  locked: bigint;
  minted: bigint;
  violated: boolean;
}

/**
 * Cross-chain supply invariant for one native->wrapped pair. Returns null
 * when the mapping is not a native->wrapped direction (config mappings exist
 * in both directions; the reverse entry is skipped rather than misread).
 *
 * Ordering makes false positives impossible for a healthy bridge: locking
 * always precedes minting, and burning always precedes releasing, so at
 * every instant minted <= locked. Any observation of minted > locked is a
 * genuine violation, not an in-flight message.
 */
export async function checkCrossChainPair(
  srcRunner: ethers.ContractRunner,
  srcBridgeAddress: string,
  srcToken: string,
  destRunner: ethers.ContractRunner,
  destBridgeAddress: string,
  destToken: string
): Promise<PairStatus | null> {
  const src = new ethers.Contract(srcBridgeAddress, MONITOR_BRIDGE_ABI, srcRunner);
  const dest = new ethers.Contract(destBridgeAddress, MONITOR_BRIDGE_ABI, destRunner);
  if (Number(await src.tokenType(srcToken)) !== 1) return null;
  if (Number(await dest.tokenType(destToken)) !== 2) return null;
  const locked: bigint = await src.lockedBalance(srcToken);
  const minted: bigint = await dest.mintedSupply(destToken);
  return { locked, minted, violated: minted > locked };
}
