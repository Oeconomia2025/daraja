import * as fs from "fs";
import * as path from "path";
import { ethers } from "ethers";
import "dotenv/config";
import { BridgeConfig, chunkRanges } from "./lib";
import {
  MONITOR_BRIDGE_ABI,
  checkCrossChainPair,
  checkTokenInvariant,
} from "./monitorCore";
import { JsonStore } from "./store";

/**
 * Oeconomia bridge monitoring daemon.
 *
 * Watches every configured chain for:
 *  1. LOCAL invariant breaks (backing < locked, supply > minted). Free
 *     off-chain reads every cycle; on a real violation it calls the
 *     permissionless on-chain check, which pauses the bridge in the same
 *     transaction.
 *  2. CROSS-CHAIN supply divergence (minted on dest > locked on source).
 *     Only this daemon can see it; responds with a guardian votePause on
 *     BOTH sides of the pair.
 *  3. Alert-worthy events: invariant violations, pauses, large outflows,
 *     and every privileged configuration change on the bridge and registry.
 *
 * Response authority: one monitor holds at most ONE guardian key
 * (MONITOR_GUARDIAN_KEY), and pausing requires a quorum of guardians (>= 2),
 * so a compromised monitor cannot freeze the bridge alone. Run at least two
 * monitor instances with different guardian keys for automated pausing; a
 * keyless monitor still alerts.
 *
 * Alerts go to stdout and, if MONITOR_WEBHOOK_URL is set, are POSTed as JSON
 * (works with Discord webhooks via the `content` field).
 */

const CONFIG_PATH = process.env.BRIDGE_CONFIG || path.join(__dirname, "config.json");

const EVENT_ABI = [
  // critical
  "event InvariantViolation(address indexed token, uint256 expected, uint256 actual)",
  "event Paused(address account)",
  // warning: funds outflow anomaly and pause activity
  "event LargeOutflow(address indexed token, address indexed recipient, uint256 amount)",
  "event PauseVoted(address indexed guardian, uint256 indexed round, uint256 votes)",
  "event Unpaused(address account)",
  // warning: privileged configuration changes (timelocked, but must be seen)
  "event TokenRegistered(address indexed token, uint8 tokenType)",
  "event ChainSupportSet(uint256 indexed chainId, bool supported)",
  "event RateLimitSet(address indexed token, uint256 maxPerWindow)",
  "event LargeOutflowThresholdSet(address indexed token, uint256 threshold)",
  "event GuardianAdded(address indexed guardian)",
  "event GuardianRemoved(address indexed guardian)",
  "event PauseQuorumChanged(uint256 oldQuorum, uint256 newQuorum)",
  "event ValidatorAdded(address indexed validator)",
  "event ValidatorRemoved(address indexed validator)",
  "event ThresholdChanged(uint256 oldThreshold, uint256 newThreshold)",
];

const CRITICAL_EVENTS = new Set(["InvariantViolation", "Paused"]);

type Severity = "CRITICAL" | "WARNING" | "INFO";

async function alert(severity: Severity, chain: string, message: string) {
  const line = `[${severity}] [${chain}] ${message}`;
  if (severity === "CRITICAL") console.error(line);
  else console.log(line);

  const webhook = process.env.MONITOR_WEBHOOK_URL;
  if (!webhook) return;
  try {
    await fetch(webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: line, severity, chain, message }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    console.warn("webhook delivery failed:", err instanceof Error ? err.message : err);
  }
}

async function main() {
  const cfg: BridgeConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  const store = new JsonStore(
    process.env.MONITOR_STORE || path.join(__dirname, "data", "monitor.json")
  );

  const guardianKey = process.env.MONITOR_GUARDIAN_KEY;
  if (!guardianKey) {
    console.warn(
      "MONITOR_GUARDIAN_KEY not set: monitor will alert but cannot vote to pause or trigger on-chain checks"
    );
  }

  const iface = new ethers.Interface(EVENT_ABI);

  interface ChainCtx {
    key: string;
    provider: ethers.JsonRpcProvider;
    bridgeAddress: string;
    registryAddress: string;
    bridge: ethers.Contract; // connected to guardian wallet when available
    tokens: string[]; // every token this chain appears with in the mappings
  }
  const chains: ChainCtx[] = [];

  for (const [key, chain] of Object.entries(cfg.chains)) {
    const provider = new ethers.JsonRpcProvider(chain.rpcUrl);
    const network = await provider.getNetwork();
    if (network.chainId !== BigInt(chain.chainId)) {
      throw new Error(
        `RPC for '${key}' reports chain ${network.chainId}, config says ${chain.chainId} - refusing to run`
      );
    }
    const runner = guardianKey ? new ethers.Wallet(guardianKey, provider) : provider;
    const bridge = new ethers.Contract(chain.bridge, MONITOR_BRIDGE_ABI, runner);
    const registryAddress: string = await bridge.registry();

    const tokens = new Set<string>();
    for (const m of cfg.tokenMappings) {
      if (m.sourceChain === key) tokens.add(m.sourceToken);
      if (m.destChain === key) tokens.add(m.destToken);
    }
    chains.push({
      key,
      provider,
      bridgeAddress: chain.bridge,
      registryAddress,
      bridge,
      tokens: [...tokens],
    });
    console.log(
      `Monitoring ${key} (chain ${chain.chainId}): bridge ${chain.bridge}, registry ${registryAddress}, ${tokens.size} tokens`
    );
  }

  // Alert once per unhealthy state, not once per polling cycle.
  const activeViolations = new Set<string>();

  async function respondOnChain(ctx: ChainCtx, action: () => Promise<unknown>, label: string) {
    if (!guardianKey) {
      await alert("WARNING", ctx.key, `no guardian key configured; cannot ${label}`);
      return;
    }
    try {
      await action();
      await alert("WARNING", ctx.key, `submitted ${label}`);
    } catch (err) {
      // "already voted this round" and "already paused" are expected here.
      console.warn(`[${ctx.key}] ${label} not submitted:`, err instanceof Error ? err.message : err);
    }
  }

  async function runLocalChecks(ctx: ChainCtx) {
    for (const token of ctx.tokens) {
      const status = await checkTokenInvariant(ctx.provider, ctx.bridgeAddress, token);
      const vKey = `${ctx.key}:${token}`;
      if (!status.violated) {
        activeViolations.delete(vKey);
        continue;
      }
      if (!activeViolations.has(vKey)) {
        activeViolations.add(vKey);
        await alert(
          "CRITICAL",
          ctx.key,
          `${status.kind} invariant violated for ${token}: expected ${status.expected}, actual ${status.actual}`
        );
      }
      // The on-chain check re-verifies and pauses the bridge itself.
      const fn = status.kind === "Native" ? "checkNativeInvariant" : "checkWrappedInvariant";
      if (!(await ctx.bridge.paused())) {
        await respondOnChain(ctx, () => ctx.bridge[fn](token), `${fn}(${token})`);
      }
    }
  }

  async function runCrossChainChecks() {
    for (const m of cfg.tokenMappings) {
      const src = chains.find((c) => c.key === m.sourceChain);
      const dest = chains.find((c) => c.key === m.destChain);
      if (!src || !dest) continue;
      const status = await checkCrossChainPair(
        src.provider, src.bridgeAddress, m.sourceToken,
        dest.provider, dest.bridgeAddress, m.destToken
      );
      if (!status) continue; // reverse-direction mapping entry
      const vKey = `pair:${m.sourceChain}:${m.sourceToken}->${m.destChain}:${m.destToken}`;
      if (!status.violated) {
        activeViolations.delete(vKey);
        continue;
      }
      if (!activeViolations.has(vKey)) {
        activeViolations.add(vKey);
        await alert(
          "CRITICAL",
          `${m.sourceChain}->${m.destChain}`,
          `cross-chain supply violated: minted ${status.minted} on ${m.destChain} exceeds locked ${status.locked} on ${m.sourceChain}`
        );
      }
      // No contract can see this - guardian votes to pause BOTH sides.
      for (const ctx of [src, dest]) {
        if (!(await ctx.bridge.paused())) {
          await respondOnChain(ctx, () => ctx.bridge.votePause(), "votePause()");
        }
      }
    }
  }

  async function scanEvents(ctx: ChainCtx) {
    const latest = await ctx.provider.getBlockNumber();
    const from = (store.getWatermark(ctx.key) ?? latest - 1) + 1;
    if (from > latest) return;
    for (const [start, end] of chunkRanges(from, latest)) {
      const logs = await ctx.provider.getLogs({
        address: [ctx.bridgeAddress, ctx.registryAddress],
        fromBlock: start,
        toBlock: end,
      });
      for (const log of logs) {
        const parsed = iface.parseLog(log);
        if (!parsed) continue; // routine event not in the alert list
        const args = parsed.args.map((a) => String(a)).join(", ");
        const severity: Severity = CRITICAL_EVENTS.has(parsed.name) ? "CRITICAL" : "WARNING";
        await alert(severity, ctx.key, `${parsed.name}(${args}) tx=${log.transactionHash}`);
      }
      store.setWatermark(ctx.key, end);
    }
  }

  const interval = cfg.monitor?.pollIntervalMs || 30000;
  for (;;) {
    for (const ctx of chains) {
      try {
        await runLocalChecks(ctx);
        await scanEvents(ctx);
      } catch (err) {
        console.error(`[${ctx.key}] monitor pass error:`, err instanceof Error ? err.message : err);
      }
    }
    try {
      await runCrossChainChecks();
    } catch (err) {
      console.error("cross-chain check error:", err instanceof Error ? err.message : err);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
