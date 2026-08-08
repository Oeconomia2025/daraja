// Minimal ABIs the bridge frontend needs. The frontend only ever calls the
// OUTBOUND user functions (lock, burn) and reads; the quorum-verified inbound
// paths are the relayer's job.

export const bridgeAbi = [
  {
    type: "function",
    name: "lockTokens",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "destChainId", type: "uint256" },
      { name: "recipient", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "burnWrapped",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "destChainId", type: "uint256" },
      { name: "recipient", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "processedMessages",
    stateMutability: "view",
    inputs: [{ name: "digest", type: "bytes32" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "paused",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bool" }],
  },
  {
    type: "event",
    name: "TokensLocked",
    inputs: [
      { name: "nonce", type: "uint256", indexed: true },
      { name: "token", type: "address", indexed: true },
      { name: "sender", type: "address", indexed: true },
      { name: "recipient", type: "address", indexed: false },
      { name: "amountReceived", type: "uint256", indexed: false },
      { name: "destChainId", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "WrappedBurned",
    inputs: [
      { name: "nonce", type: "uint256", indexed: true },
      { name: "token", type: "address", indexed: true },
      { name: "sender", type: "address", indexed: true },
      { name: "recipient", type: "address", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
      { name: "destChainId", type: "uint256", indexed: false },
    ],
  },
] as const;

export const erc20Abi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;
