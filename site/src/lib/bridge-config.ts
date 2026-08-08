// Oeconomia Bridge frontend configuration.
// SOURCE OF TRUTH lives in bridge-claude-workspace/site/src/lib/ - the copy in
// eloqura-claude-workspace/client/src/lib/ must be kept identical.
//
// After deploying contracts (scripts/deploy.ts on each chain), fill in the
// `bridge` address per chain and the wrapped token addresses below. The UI
// stays in "awaiting deployment" mode while any required address is zero.

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

export type ChainKey = "sepolia" | "bscTestnet";

/** Literal union so wagmi's typed multichain reads accept these directly. */
export type BridgeChainId = 11155111 | 97;

export interface BridgeChain {
  key: ChainKey;
  chainId: BridgeChainId;
  name: string;
  logo: string;
  explorer: string;
  bridge: `0x${string}`;
  /** Matches the validators' finality wait; sets user expectations in the UI. */
  estimatedMinutes: number;
}

export const BRIDGE_CHAINS: Record<ChainKey, BridgeChain> = {
  sepolia: {
    key: "sepolia",
    chainId: 11155111,
    name: "Sepolia",
    logo: "https://s2.coinmarketcap.com/static/img/coins/64x64/1027.png",
    explorer: "https://sepolia.etherscan.io",
    bridge: ZERO_ADDRESS, // TODO: fill after deployment
    estimatedMinutes: 3,
  },
  bscTestnet: {
    key: "bscTestnet",
    chainId: 97,
    name: "BSC Testnet",
    logo: "https://s2.coinmarketcap.com/static/img/coins/64x64/1839.png",
    explorer: "https://testnet.bscscan.com",
    bridge: ZERO_ADDRESS, // TODO: fill after deployment
    estimatedMinutes: 2,
  },
};

export interface TokenDeployment {
  address: `0x${string}`;
  /** native = locked/released on this chain; wrapped = minted/burned. */
  kind: "native" | "wrapped";
}

export interface BridgeTokenInfo {
  symbol: string;
  name: string;
  decimals: number;
  logo: string;
  deployments: Partial<Record<ChainKey, TokenDeployment>>;
}

export const BRIDGE_TOKENS: BridgeTokenInfo[] = [
  {
    symbol: "OEC",
    name: "Oeconomia",
    decimals: 18,
    logo: "https://pub-37d61a7eb7ae45898b46702664710cb2.r2.dev/images/OEC%20Logo%20Square.png",
    deployments: {
      sepolia: {
        address: "0x2b2fb8df4ac5d394f0d5674d7a54802e42a06aba",
        kind: "native",
      },
      bscTestnet: {
        address: ZERO_ADDRESS, // TODO: BridgedToken (wOEC) after deployment
        kind: "wrapped",
      },
    },
  },
];

export function isBridgeDeployed(chain: BridgeChain): boolean {
  return chain.bridge !== ZERO_ADDRESS;
}

export function chainByKey(key: ChainKey): BridgeChain {
  return BRIDGE_CHAINS[key];
}

export function chainById(chainId: number): BridgeChain | undefined {
  return Object.values(BRIDGE_CHAINS).find((c) => c.chainId === chainId);
}

/** Tokens usable for a given direction: deployed on both sides. */
export function tokensForRoute(from: ChainKey, to: ChainKey): BridgeTokenInfo[] {
  return BRIDGE_TOKENS.filter((t) => {
    const src = t.deployments[from];
    const dest = t.deployments[to];
    return src && dest && src.address !== ZERO_ADDRESS && dest.address !== ZERO_ADDRESS;
  });
}
