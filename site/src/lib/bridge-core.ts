// Transfer construction and tracking shared by the standalone bridge site and
// the Eloqura bridge page. Mirrors offchain/lib.ts and BridgeMessages.sol:
// the digest computed here is byte-identical to the one validators sign and
// the destination bridge stores in processedMessages, which is what lets the
// frontend track a transfer to completion with nothing but public reads.

import { hashTypedData, parseEventLogs, parseUnits, type TransactionReceipt } from "viem";
import { bridgeAbi } from "./bridge-abi";
import { BridgeTokenInfo, ChainKey, chainByKey } from "./bridge-config";

export const ACTION_RELEASE = 1;
export const ACTION_MINT = 2;

const BRIDGE_MESSAGE_TYPES = {
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
} as const;

export interface PendingTransfer {
  /** The EIP-712 digest - also the transfer's identity on the destination. */
  digest: `0x${string}`;
  sourceChain: ChainKey;
  destChain: ChainKey;
  tokenSymbol: string;
  /** Raw units as decimal string (JSON-safe). */
  amount: string;
  nonce: string;
  sourceTxHash: string;
  recipient: `0x${string}`;
  createdAt: number;
  status: "pending" | "complete";
}

/**
 * Parse the bridge event out of a lock/burn receipt and compute the digest
 * the destination bridge will mark processed. Returns null if the receipt
 * contains no bridge event (wrong tx).
 */
export function transferFromReceipt(
  receipt: TransactionReceipt,
  sourceChain: ChainKey,
  destChain: ChainKey,
  token: BridgeTokenInfo
): PendingTransfer | null {
  const logs = parseEventLogs({
    abi: bridgeAbi,
    logs: receipt.logs,
    eventName: ["TokensLocked", "WrappedBurned"],
  });
  if (logs.length === 0) return null;
  const ev = logs[0];

  const src = chainByKey(sourceChain);
  const dest = chainByKey(destChain);
  const destToken = token.deployments[destChain];
  if (!destToken) return null;

  const action = ev.eventName === "TokensLocked" ? ACTION_MINT : ACTION_RELEASE;
  const amount =
    ev.eventName === "TokensLocked" ? ev.args.amountReceived : ev.args.amount;
  const recipient = ev.args.recipient as `0x${string}`;
  const nonce = ev.args.nonce as bigint;

  const digest = hashTypedData({
    domain: {
      name: "OeconomiaBridge",
      version: "1",
      chainId: BigInt(dest.chainId),
      verifyingContract: dest.bridge,
    },
    types: BRIDGE_MESSAGE_TYPES,
    primaryType: "BridgeMessage",
    message: {
      action,
      sourceChainId: BigInt(src.chainId),
      destChainId: BigInt(dest.chainId),
      bridge: dest.bridge,
      token: destToken.address,
      recipient,
      amount,
      nonce,
    },
  });

  return {
    digest,
    sourceChain,
    destChain,
    tokenSymbol: token.symbol,
    amount: amount.toString(),
    nonce: nonce.toString(),
    sourceTxHash: receipt.transactionHash,
    recipient,
    createdAt: Date.now(),
    status: "pending",
  };
}

/**
 * Sanitize a user-typed amount for parseUnits: floats can carry more decimals
 * than the token supports, which overflows parseUnits.
 */
export function parseAmount(input: string, decimals: number): bigint {
  const trimmed = input.trim();
  if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === "" || trimmed === ".") {
    throw new Error("invalid amount");
  }
  const [whole, frac = ""] = trimmed.split(".");
  const safe = frac.length > decimals ? `${whole}.${frac.slice(0, decimals)}` : trimmed;
  return parseUnits(safe, decimals);
}

// ------------------------------------------------------------------
// localStorage persistence so transfers survive refresh
// ------------------------------------------------------------------

const STORAGE_KEY = "oeconomia-bridge-transfers";

export function loadTransfers(): PendingTransfer[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as PendingTransfer[]) : [];
  } catch {
    return [];
  }
}

export function saveTransfers(transfers: PendingTransfer[]) {
  // Keep the most recent 25 to bound storage.
  const sorted = [...transfers].sort((a, b) => b.createdAt - a.createdAt).slice(0, 25);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sorted));
}

export function upsertTransfer(transfer: PendingTransfer): PendingTransfer[] {
  const all = loadTransfers().filter((t) => t.digest !== transfer.digest);
  all.push(transfer);
  saveTransfers(all);
  return loadTransfers();
}
