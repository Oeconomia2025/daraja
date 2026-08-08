import { useCallback, useEffect, useMemo, useState } from "react";
import {
  useAccount,
  useConnect,
  useDisconnect,
  usePublicClient,
  useReadContract,
  useSwitchChain,
  useWriteContract,
} from "wagmi";
import { readContract } from "wagmi/actions";
import { formatUnits } from "viem";
import { config } from "./wagmi";
import { bridgeAbi, erc20Abi } from "./lib/bridge-abi";
import {
  BRIDGE_CHAINS,
  ChainKey,
  chainByKey,
  isBridgeDeployed,
  tokensForRoute,
} from "./lib/bridge-config";
import {
  PendingTransfer,
  loadTransfers,
  parseAmount,
  saveTransfers,
  transferFromReceipt,
  upsertTransfer,
} from "./lib/bridge-core";

type FlowState = "idle" | "approving" | "bridging" | "confirming";

function short(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function formatAmount(raw: string, decimals: number): string {
  const n = Number(formatUnits(BigInt(raw), decimals));
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

export default function App() {
  const [fromKey, setFromKey] = useState<ChainKey>("sepolia");
  const toKey: ChainKey = fromKey === "sepolia" ? "bscTestnet" : "sepolia";
  const from = chainByKey(fromKey);
  const to = chainByKey(toKey);

  const routeTokens = useMemo(() => tokensForRoute(fromKey, toKey), [fromKey, toKey]);
  const [tokenSymbol, setTokenSymbol] = useState<string>(routeTokens[0]?.symbol ?? "");
  const token = routeTokens.find((t) => t.symbol === tokenSymbol) ?? routeTokens[0];
  useEffect(() => {
    if (token && tokenSymbol !== token.symbol) setTokenSymbol(token.symbol);
  }, [token, tokenSymbol]);

  const [amount, setAmount] = useState("");
  const [flow, setFlow] = useState<FlowState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [transfers, setTransfers] = useState<PendingTransfer[]>(() => loadTransfers());

  const { address, isConnected, chainId } = useAccount();
  const { connect, connectors } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient({ chainId: from.chainId });

  const deployed = isBridgeDeployed(from) && isBridgeDeployed(to) && !!token;
  const srcToken = token?.deployments[fromKey];

  const { data: balance } = useReadContract({
    chainId: from.chainId,
    address: srcToken?.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address && !!srcToken && deployed, refetchInterval: 15000 },
  });

  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    chainId: from.chainId,
    address: srcToken?.address,
    abi: erc20Abi,
    functionName: "allowance",
    args: address ? [address, from.bridge] : undefined,
    query: { enabled: !!address && !!srcToken && deployed },
  });

  const parsedAmount = useMemo(() => {
    if (!token || !amount) return null;
    try {
      const v = parseAmount(amount, token.decimals);
      return v > 0n ? v : null;
    } catch {
      return null;
    }
  }, [amount, token]);

  const needsApproval =
    parsedAmount !== null && allowance !== undefined && (allowance as bigint) < parsedAmount;
  const insufficient =
    parsedAmount !== null && balance !== undefined && (balance as bigint) < parsedAmount;

  // Poll destination bridges for pending transfers landing.
  useEffect(() => {
    const pending = transfers.filter((t) => t.status === "pending");
    if (pending.length === 0) return;
    const timer = setInterval(async () => {
      let changed = false;
      const updated = await Promise.all(
        transfers.map(async (t) => {
          if (t.status !== "pending") return t;
          const dest = chainByKey(t.destChain);
          if (!isBridgeDeployed(dest)) return t;
          try {
            const done = await readContract(config, {
              chainId: dest.chainId,
              address: dest.bridge,
              abi: bridgeAbi,
              functionName: "processedMessages",
              args: [t.digest],
            });
            if (done) {
              changed = true;
              return { ...t, status: "complete" as const };
            }
          } catch {
            /* transient RPC failure - retry next tick */
          }
          return t;
        })
      );
      if (changed) {
        saveTransfers(updated);
        setTransfers(loadTransfers());
      }
    }, 10000);
    return () => clearInterval(timer);
  }, [transfers]);

  const flip = () => {
    setFromKey(toKey);
    setAmount("");
    setError(null);
  };

  const setMax = () => {
    if (balance !== undefined && token) {
      setAmount(formatUnits(balance as bigint, token.decimals));
    }
  };

  const handleAction = useCallback(async () => {
    setError(null);
    if (!isConnected) {
      const preferred = connectors.find((c) => c.id === "metaMaskSDK") ?? connectors[0];
      if (preferred) connect({ connector: preferred });
      return;
    }
    if (!deployed || !token || !srcToken || !parsedAmount || !address || !publicClient) return;

    try {
      if (chainId !== from.chainId) {
        await switchChainAsync({ chainId: from.chainId });
      }

      if (needsApproval) {
        setFlow("approving");
        const approveHash = await writeContractAsync({
          chainId: from.chainId,
          address: srcToken.address,
          abi: erc20Abi,
          functionName: "approve",
          args: [from.bridge, parsedAmount],
        });
        await publicClient.waitForTransactionReceipt({ hash: approveHash });
        await refetchAllowance();
        setFlow("idle");
        return;
      }

      setFlow("bridging");
      const fn = srcToken.kind === "native" ? "lockTokens" : "burnWrapped";
      const hash = await writeContractAsync({
        chainId: from.chainId,
        address: from.bridge,
        abi: bridgeAbi,
        functionName: fn,
        args: [srcToken.address, parsedAmount, BigInt(to.chainId), address],
      });

      setFlow("confirming");
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      const transfer = transferFromReceipt(receipt, fromKey, toKey, token);
      if (transfer) {
        setTransfers(upsertTransfer(transfer));
      }
      setAmount("");
      setFlow("idle");
    } catch (err) {
      setFlow("idle");
      const message = err instanceof Error ? err.message : String(err);
      setError(message.split("\n")[0].slice(0, 160));
    }
  }, [
    isConnected, connectors, connect, deployed, token, srcToken, parsedAmount,
    address, publicClient, chainId, from, to, fromKey, toKey, needsApproval,
    switchChainAsync, writeContractAsync, refetchAllowance,
  ]);

  const buttonLabel = !isConnected
    ? "Connect Wallet"
    : !deployed
      ? "Awaiting Testnet Deployment"
      : !parsedAmount
        ? "Enter Amount"
        : insufficient
          ? "Insufficient Balance"
          : chainId !== from.chainId
            ? `Switch to ${from.name}`
            : flow === "approving"
              ? "Approving..."
              : flow === "bridging"
                ? "Confirm in Wallet..."
                : flow === "confirming"
                  ? "Waiting for Confirmation..."
                  : needsApproval
                    ? `Approve ${token?.symbol}`
                    : `Bridge to ${to.name}`;

  const buttonDisabled =
    isConnected && (!deployed || !parsedAmount || insufficient || flow !== "idle");

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 border-b border-crypto-border/60">
        <div className="flex items-center space-x-3">
          <img src="/oec-logo.png" alt="OEC" className="w-9 h-9 rounded-full" />
          <div>
            <h1 className="text-lg font-bold">
              <span className="gradient-text">Daraja</span>
            </h1>
            <p className="text-xs text-gray-500">Oeconomia Bridge · Sepolia ↔ BSC Testnet</p>
          </div>
        </div>
        {isConnected && address ? (
          <button
            onClick={() => disconnect()}
            className="gradient-border rounded-lg px-4 py-2 text-sm hover:opacity-80 transition-opacity"
            title="Disconnect"
          >
            {short(address)}
          </button>
        ) : (
          <button
            onClick={handleAction}
            className="gradient-button rounded-lg px-4 py-2 text-sm font-semibold hover:opacity-90 transition-opacity"
          >
            Connect Wallet
          </button>
        )}
      </header>

      <main className="flex-1 flex flex-col items-center px-4 py-10 space-y-6">
        {/* Testnet banner */}
        <div className="w-full max-w-lg rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-4 py-2 text-center text-xs text-yellow-400">
          Testnet build. Contracts are pre-audit; do not bridge assets with real value.
        </div>

        {/* Bridge card */}
        <div className="w-full max-w-lg bg-crypto-card border border-crypto-border rounded-2xl p-5 shadow-2xl shadow-black/60">
          {/* From */}
          <div className="bg-gradient-to-b from-[#121315] to-black rounded-xl p-4 border border-crypto-border">
            <div className="flex items-center justify-between mb-3">
              <span className="text-gray-400 text-sm">From</span>
              <button onClick={setMax} className="text-xs text-crypto-blue hover:underline">
                Balance:{" "}
                {balance !== undefined && token
                  ? formatAmount((balance as bigint).toString(), token.decimals)
                  : "0"}{" "}
                (Max)
              </button>
            </div>
            <div className="flex items-center space-x-2 mb-4">
              <img src={from.logo} alt={from.name} className="w-6 h-6 rounded-full" />
              <span className="font-medium">{from.name}</span>
            </div>
            <div className="flex items-center space-x-3">
              <input
                type="number"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.0"
                className="flex-1 bg-transparent text-3xl font-bold placeholder-gray-600 outline-none min-w-0"
              />
              <div className="flex items-center space-x-2 bg-crypto-card border border-crypto-border rounded-lg px-3 py-2">
                {token ? (
                  <>
                    <img src={token.logo} alt={token.symbol} className="w-6 h-6 rounded-full" />
                    <span className="font-medium">{token.symbol}</span>
                  </>
                ) : (
                  <span className="text-gray-500 text-sm">No tokens</span>
                )}
              </div>
            </div>
          </div>

          {/* Flip */}
          <div className="flex justify-center -my-3 relative z-10">
            <button
              onClick={flip}
              className="w-10 h-10 rounded-full bg-crypto-card border-2 border-crypto-border flex items-center justify-center hover:border-crypto-blue transition-colors"
              title="Swap direction"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-gray-400">
                <path d="M12 3v18M6 15l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>

          {/* To */}
          <div className="bg-gradient-to-b from-[#121315] to-black rounded-xl p-4 border border-crypto-border">
            <div className="flex items-center justify-between mb-3">
              <span className="text-gray-400 text-sm">To</span>
              <span className="text-xs text-gray-500">~{to.estimatedMinutes} min</span>
            </div>
            <div className="flex items-center space-x-2 mb-4">
              <img src={to.logo} alt={to.name} className="w-6 h-6 rounded-full" />
              <span className="font-medium">{to.name}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-3xl font-bold text-gray-400">{amount || "0.0"}</span>
              <span className="text-sm text-gray-500">
                {token
                  ? srcToken?.kind === "native"
                    ? `w${token.symbol} (wrapped)`
                    : token.symbol
                  : ""}
              </span>
            </div>
          </div>

          {/* Info */}
          <div className="mt-4 rounded-lg border border-crypto-border bg-black/30 p-3 space-y-1.5 text-xs text-gray-400">
            <div className="flex justify-between">
              <span>Transfer type</span>
              <span className="text-gray-300">
                {srcToken?.kind === "native" ? "Lock and mint" : "Burn and release"}
              </span>
            </div>
            <div className="flex justify-between">
              <span>Bridge fee</span>
              <span className="text-gray-300">None (gas only)</span>
            </div>
            <div className="flex justify-between">
              <span>Security</span>
              <span className="text-gray-300">Validator quorum + rate limits</span>
            </div>
          </div>

          {error && (
            <div className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400 break-words">
              {error}
            </div>
          )}

          <button
            onClick={handleAction}
            disabled={buttonDisabled}
            className="mt-4 w-full gradient-button rounded-xl py-4 font-semibold text-white disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90 transition-opacity"
          >
            {flow !== "idle" && (
              <span className="inline-block w-4 h-4 mr-2 border-2 border-white border-t-transparent rounded-full animate-spin align-middle" />
            )}
            {buttonLabel}
          </button>
        </div>

        {/* Transfers */}
        {transfers.length > 0 && (
          <div className="w-full max-w-lg bg-crypto-card border border-crypto-border rounded-2xl p-5">
            <h2 className="text-sm font-semibold text-gray-300 mb-3">Your Transfers</h2>
            <div className="space-y-2">
              {transfers.map((t) => {
                const tk = tokensForRoute(t.sourceChain, t.destChain).find(
                  (x) => x.symbol === t.tokenSymbol
                );
                const src = chainByKey(t.sourceChain);
                return (
                  <div
                    key={t.digest}
                    className="flex items-center justify-between rounded-lg border border-crypto-border bg-black/30 px-3 py-2.5 text-sm"
                  >
                    <div>
                      <div className="text-white">
                        {tk ? formatAmount(t.amount, tk.decimals) : t.amount} {t.tokenSymbol}
                      </div>
                      <div className="text-xs text-gray-500">
                        {chainByKey(t.sourceChain).name} → {chainByKey(t.destChain).name} ·{" "}
                        <a
                          href={`${src.explorer}/tx/${t.sourceTxHash}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-crypto-blue hover:underline"
                        >
                          tx
                        </a>
                      </div>
                    </div>
                    {t.status === "complete" ? (
                      <span className="rounded-full bg-green-500/15 border border-green-500/30 px-2.5 py-0.5 text-xs text-green-400">
                        Complete
                      </span>
                    ) : (
                      <span className="rounded-full bg-yellow-500/15 border border-yellow-500/30 px-2.5 py-0.5 text-xs text-yellow-400 flex items-center">
                        <span className="w-2 h-2 mr-1.5 rounded-full bg-yellow-400 animate-pulse" />
                        Pending
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </main>

      <footer className="px-6 py-4 text-center text-xs text-gray-600 border-t border-crypto-border/60">
        Daraja · lock-and-mint with validator quorum, timelocked admin, and outflow rate
        limits ·{" "}
        <a href="https://oeconomia.io" target="_blank" rel="noreferrer" className="text-crypto-blue hover:underline">
          oeconomia.io
        </a>
      </footer>
    </div>
  );
}
