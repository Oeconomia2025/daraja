import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { ethers } from "ethers";
import "dotenv/config";
import {
  BRIDGE_ABI,
  BridgeConfig,
  SourceEvent,
  buildMessage,
  chunkRanges,
  computeDigest,
  findMapping,
  msgToJson,
  signMessage,
} from "./lib";
import { JsonStore } from "./store";

/**
 * Daraja validator daemon.
 *
 * SECURITY POSTURE
 *  - Signs ONLY events this process read from its own configured RPC, and
 *    only after the event is `confirmations` blocks deep. Nothing received
 *    over HTTP, from peers, or from any external party is ever signed.
 *  - The HTTP API is strictly read-only (GET). Signatures are public
 *    material: they are useless below quorum and are bound to one action on
 *    one destination bridge on one chain, so serving them requires no auth.
 *  - Signs only token pairs explicitly present in the config allowlist.
 *    Unknown tokens and unknown destination chains are logged and skipped.
 *  - Refuses to start if any RPC reports a chain id different from the
 *    config, so a misconfigured or malicious RPC cannot cause signatures
 *    for the wrong domain.
 *  - Signing is deterministic: re-observing the same event reproduces the
 *    same digest, so restarts and re-scans are idempotent.
 */

const CONFIG_PATH = process.env.BRIDGE_CONFIG || path.join(__dirname, "config.json");

async function main() {
  const cfg: BridgeConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));

  const pk = process.env.VALIDATOR_PRIVATE_KEY;
  if (!pk) throw new Error("VALIDATOR_PRIVATE_KEY is not set");
  const wallet = new ethers.Wallet(pk);
  console.log(`Validator address: ${wallet.address}`);

  const store = new JsonStore(
    process.env.VALIDATOR_STORE ||
      path.join(__dirname, "data", `validator-${wallet.address.toLowerCase()}.json`)
  );

  const iface = new ethers.Interface(BRIDGE_ABI);
  const lockedTopic = iface.getEvent("TokensLocked")!.topicHash;
  const burnedTopic = iface.getEvent("WrappedBurned")!.topicHash;

  // Startup check: every RPC must agree with the configured chain id.
  const providers: Record<string, ethers.JsonRpcProvider> = {};
  for (const [key, chain] of Object.entries(cfg.chains)) {
    const provider = new ethers.JsonRpcProvider(chain.rpcUrl);
    const network = await provider.getNetwork();
    if (network.chainId !== BigInt(chain.chainId)) {
      throw new Error(
        `RPC for '${key}' reports chain ${network.chainId}, config says ${chain.chainId} - refusing to run`
      );
    }
    providers[key] = provider;
    console.log(`Connected to ${key} (chain ${chain.chainId}) at block ${await provider.getBlockNumber()}`);
  }

  async function handleEvent(sourceChainKey: string, ev: SourceEvent) {
    const found = findMapping(cfg, sourceChainKey, ev.token, ev.destChainId);
    if (!found) {
      console.warn(
        `[${sourceChainKey}] SKIP ${ev.kind} nonce=${ev.nonce} token=${ev.token} dest=${ev.destChainId}: not in token allowlist`
      );
      return;
    }
    const destChain = cfg.chains[found.destChainKey];
    const message = buildMessage(ev, destChain.bridge, found.mapping.destToken);
    const digest = computeDigest(message);
    if (store.hasSignature(digest)) return;

    const signature = await signMessage(wallet, message);
    store.addSignature({
      digest,
      message: msgToJson(message),
      signature,
      signer: wallet.address,
      sourceChain: sourceChainKey,
      txHash: ev.txHash,
      logIndex: ev.logIndex,
      signedAt: new Date().toISOString(),
    });
    console.log(
      `[${sourceChainKey}] SIGNED ${ev.kind} nonce=${ev.nonce} amount=${ev.amount} -> ${found.destChainKey} digest=${digest}`
    );
  }

  async function pollChain(key: string) {
    const chain = cfg.chains[key];
    const provider = providers[key];
    const latest = await provider.getBlockNumber();
    // Finality wait: never look at anything shallower than `confirmations`.
    const safe = latest - chain.confirmations;
    const from = (store.getWatermark(key) ?? chain.startBlock - 1) + 1;
    if (from > safe) return;

    for (const [start, end] of chunkRanges(from, safe)) {
      const logs = await provider.getLogs({
        address: chain.bridge,
        topics: [[lockedTopic, burnedTopic]],
        fromBlock: start,
        toBlock: end,
      });
      for (const log of logs) {
        const parsed = iface.parseLog(log);
        if (!parsed) continue;
        const kind = parsed.name as "TokensLocked" | "WrappedBurned";
        await handleEvent(key, {
          kind,
          sourceChainId: BigInt(chain.chainId),
          nonce: parsed.args[0],
          token: parsed.args[1],
          recipient: parsed.args[3],
          amount: parsed.args[4],
          destChainId: parsed.args[5],
          txHash: log.transactionHash,
          logIndex: log.index,
        });
      }
      // Watermark advances only after every event in the chunk is signed
      // and persisted, so a crash re-scans rather than skips.
      store.setWatermark(key, end);
    }
  }

  // Read-only API for relayers.
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    res.setHeader("content-type", "application/json");
    if (req.method !== "GET") {
      res.statusCode = 405;
      return res.end(JSON.stringify({ error: "read-only API" }));
    }
    if (url.pathname === "/health") {
      return res.end(
        JSON.stringify({
          validator: wallet.address,
          chains: Object.keys(cfg.chains),
          signed: store.allSignatures().length,
        })
      );
    }
    if (url.pathname === "/messages") {
      return res.end(JSON.stringify(store.allSignatures()));
    }
    const match = url.pathname.match(/^\/messages\/(0x[0-9a-fA-F]{64})$/);
    if (match) {
      const rec = store.getSignature(match[1]);
      res.statusCode = rec ? 200 : 404;
      return res.end(JSON.stringify(rec ?? { error: "unknown digest" }));
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  });
  server.listen(cfg.validator.port, () => {
    console.log(`Signature API listening on :${cfg.validator.port} (read-only)`);
  });

  const interval = cfg.validator.pollIntervalMs || 15000;
  for (;;) {
    for (const key of Object.keys(cfg.chains)) {
      try {
        await pollChain(key);
      } catch (err) {
        console.error(`[${key}] poll error:`, err instanceof Error ? err.message : err);
      }
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
