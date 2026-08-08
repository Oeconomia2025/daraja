import { ethers } from "ethers";

/**
 * Shared logic for the off-chain validator and relayer.
 *
 * Everything here mirrors the on-chain contracts exactly:
 *  - the EIP-712 domain and struct match OeconomiaBridge / BridgeMessages.sol
 *  - quorum selection enforces the same rules ValidatorRegistry.verifyQuorum
 *    does (distinct signers, current members only, strictly ascending order),
 *    so a bundle the relayer submits is either accepted on-chain or was
 *    already invalid here.
 */

export const ACTION_RELEASE = 1;
export const ACTION_MINT = 2;

export const EIP712_TYPES = {
  BridgeMessage: [
    { name: "action", type: "uint8" },
    { name: "sourceChainId", type: "uint256" },
    { name: "destChainId", type: "uint256" },
    { name: "bridge", type: "address" },
    { name: "token", type: "address" },
    { name: "recipient", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
};

export const BRIDGE_ABI = [
  "event TokensLocked(uint256 indexed nonce, address indexed token, address indexed sender, address recipient, uint256 amountReceived, uint256 destChainId)",
  "event WrappedBurned(uint256 indexed nonce, address indexed token, address indexed sender, address recipient, uint256 amount, uint256 destChainId)",
  "function releaseTokens((uint8 action, uint256 sourceChainId, uint256 destChainId, address bridge, address token, address recipient, uint256 amount, uint256 nonce) m, bytes[] signatures)",
  "function mintWrapped((uint8 action, uint256 sourceChainId, uint256 destChainId, address bridge, address token, address recipient, uint256 amount, uint256 nonce) m, bytes[] signatures)",
  "function processedMessages(bytes32) view returns (bool)",
  "function paused() view returns (bool)",
  "function registry() view returns (address)",
];

export const REGISTRY_ABI = [
  "function isValidator(address) view returns (bool)",
  "function threshold() view returns (uint256)",
];

export interface BridgeMessage {
  action: number;
  sourceChainId: bigint;
  destChainId: bigint;
  bridge: string;
  token: string;
  recipient: string;
  amount: bigint;
  nonce: bigint;
}

/** A TokensLocked or WrappedBurned event observed on a source chain. */
export interface SourceEvent {
  kind: "TokensLocked" | "WrappedBurned";
  sourceChainId: bigint;
  nonce: bigint;
  token: string; // token on the SOURCE chain
  recipient: string;
  amount: bigint;
  destChainId: bigint;
  txHash: string;
  logIndex: number;
}

export function domainFor(destChainId: bigint, destBridge: string) {
  return {
    name: "OeconomiaBridge",
    version: "1",
    chainId: destChainId,
    verifyingContract: destBridge,
  };
}

/** The exact digest OeconomiaBridge computes via _hashTypedDataV4. */
export function computeDigest(m: BridgeMessage): string {
  return ethers.TypedDataEncoder.hash(domainFor(m.destChainId, m.bridge), EIP712_TYPES, m);
}

/**
 * Map a verified source-chain event to the message the destination bridge
 * expects. A lock on the source mints wrapped on the destination; a burn on
 * the source releases native on the destination. Refuses to build anything
 * with zero-value fields - a validator must never sign a message the
 * contract itself would reject.
 */
export function buildMessage(ev: SourceEvent, destBridge: string, destToken: string): BridgeMessage {
  if (ev.recipient === ethers.ZeroAddress) throw new Error("zero recipient");
  if (ev.amount <= 0n) throw new Error("zero amount");
  if (destBridge === ethers.ZeroAddress || destToken === ethers.ZeroAddress) {
    throw new Error("zero destination address");
  }
  if (ev.destChainId === ev.sourceChainId) throw new Error("source equals destination");
  return {
    action: ev.kind === "TokensLocked" ? ACTION_MINT : ACTION_RELEASE,
    sourceChainId: ev.sourceChainId,
    destChainId: ev.destChainId,
    bridge: destBridge,
    token: destToken,
    recipient: ev.recipient,
    amount: ev.amount,
    nonce: ev.nonce,
  };
}

export async function signMessage(wallet: ethers.Wallet | ethers.HDNodeWallet, m: BridgeMessage): Promise<string> {
  return wallet.signTypedData(domainFor(m.destChainId, m.bridge), EIP712_TYPES, m);
}

export function recoverSigner(m: BridgeMessage, signature: string): string {
  return ethers.verifyTypedData(domainFor(m.destChainId, m.bridge), EIP712_TYPES, m, signature);
}

/**
 * Select a submittable quorum from candidate signatures.
 *
 * Applies the registry's rules locally before spending gas:
 *  - recover every signature over THIS message (a signature over any altered
 *    message recovers to a different address and is dropped or rejected by
 *    the membership filter)
 *  - drop signers not in the current validator set
 *  - deduplicate signers
 *  - require at least `threshold` distinct valid signers
 *  - return signatures sorted by signer address ascending, the order
 *    ValidatorRegistry.verifyQuorum requires.
 */
export function selectQuorum(
  m: BridgeMessage,
  signatures: string[],
  validatorSet: Set<string>, // lowercase addresses
  threshold: number
): string[] {
  const bySigner = new Map<string, string>();
  for (const sig of signatures) {
    let signer: string;
    try {
      signer = recoverSigner(m, sig).toLowerCase();
    } catch {
      continue; // malformed signature - drop
    }
    if (!validatorSet.has(signer)) continue;
    if (!bySigner.has(signer)) bySigner.set(signer, sig);
  }
  if (bySigner.size < threshold) {
    throw new Error(`quorum not reached: ${bySigner.size}/${threshold} valid distinct signers`);
  }
  return [...bySigner.entries()]
    .sort(([a], [b]) => (BigInt(a) < BigInt(b) ? -1 : 1))
    .map(([, sig]) => sig);
}

/** Split a block range into getLogs-safe chunks (public RPCs cap ~5000). */
export function chunkRanges(from: number, to: number, size = 4999): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let start = from; start <= to; start += size + 1) {
    out.push([start, Math.min(start + size, to)]);
  }
  return out;
}

// JSON persistence helpers - uint256 fields travel as strings.
export interface JsonMessage {
  action: number;
  sourceChainId: string;
  destChainId: string;
  bridge: string;
  token: string;
  recipient: string;
  amount: string;
  nonce: string;
}

export function msgToJson(m: BridgeMessage): JsonMessage {
  return {
    action: m.action,
    sourceChainId: m.sourceChainId.toString(),
    destChainId: m.destChainId.toString(),
    bridge: m.bridge,
    token: m.token,
    recipient: m.recipient,
    amount: m.amount.toString(),
    nonce: m.nonce.toString(),
  };
}

export function msgFromJson(j: JsonMessage): BridgeMessage {
  return {
    action: j.action,
    sourceChainId: BigInt(j.sourceChainId),
    destChainId: BigInt(j.destChainId),
    bridge: j.bridge,
    token: j.token,
    recipient: j.recipient,
    amount: BigInt(j.amount),
    nonce: BigInt(j.nonce),
  };
}

// ------------------------------------------------------------------
// Configuration
// ------------------------------------------------------------------

export interface ChainConfig {
  chainId: number;
  rpcUrl: string;
  bridge: string;
  confirmations: number;
  startBlock: number;
}

export interface TokenMapping {
  sourceChain: string; // chain key
  sourceToken: string;
  destChain: string; // chain key
  destToken: string;
}

export interface BridgeConfig {
  chains: Record<string, ChainConfig>;
  tokenMappings: TokenMapping[];
  validator: { port: number; pollIntervalMs: number };
  relayer: { validatorEndpoints: string[]; pollIntervalMs: number };
  monitor?: { pollIntervalMs?: number };
}

export function findMapping(
  cfg: BridgeConfig,
  sourceChainKey: string,
  sourceToken: string,
  destChainId: bigint
): { mapping: TokenMapping; destChainKey: string } | null {
  for (const mapping of cfg.tokenMappings) {
    if (mapping.sourceChain !== sourceChainKey) continue;
    if (mapping.sourceToken.toLowerCase() !== sourceToken.toLowerCase()) continue;
    const dest = cfg.chains[mapping.destChain];
    if (!dest || BigInt(dest.chainId) !== destChainId) continue;
    return { mapping, destChainKey: mapping.destChain };
  }
  return null;
}
