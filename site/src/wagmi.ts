import { http, createConfig, createStorage } from "wagmi";
import { sepolia, bscTestnet } from "wagmi/chains";
import { injected, metaMask } from "wagmi/connectors";

export const config = createConfig({
  chains: [sepolia, bscTestnet],
  storage: createStorage({
    storage: typeof window !== "undefined" ? window.localStorage : undefined,
  }),
  ssr: false,
  connectors: [metaMask(), injected()],
  transports: {
    [sepolia.id]: http("https://ethereum-sepolia-rpc.publicnode.com"),
    [bscTestnet.id]: http("https://bsc-testnet-rpc.publicnode.com"),
  },
});

declare module "wagmi" {
  interface Register {
    config: typeof config;
  }
}
