import * as fs from "fs";
import * as path from "path";
import { ethers } from "ethers";
import "dotenv/config";
import {
  ACTION_MINT,
  ACTION_RELEASE,
  BRIDGE_ABI,
  BridgeConfig,
  REGISTRY_ABI,
  computeDigest,
  msgFromJson,
  recoverSigner,
  selectQuorum,
} from "./lib";
import { JsonStore, SignatureRecord } from "./store";

/**
 * Daraja relayer daemon.
 *
 * Relayers are untrusted by design: submitting a message grants no authority
 * beyond what the validator quorum signed, and the contract re-verifies
 * everything. This daemon still verifies locally before spending gas:
 *  - recomputes each record's digest from its message; a peer serving a
 *    tampered message under a stale digest is discarded
 *  - recovers every signature and checks membership against the CURRENT
 *    on-chain validator set, and reads the threshold from the chain rather
 *    than trusting config
 *  - checks the message targets a bridge address we actually operate for,
 *    skips already-processed digests, and holds off while the bridge is
 *    paused (a rate-limited or paused message is retried later, never
 *    dropped).
 */

const CONFIG_PATH = process.env.BRIDGE_CONFIG || path.join(__dirname, "config.json");

interface DestChain {
  key: string;
  chainId: bigint;
  bridge: ethers.Contract;
  registry: ethers.Contract;
  bridgeAddress: string;
}

async function main() {
  const cfg: BridgeConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));

  const pk = process.env.RELAYER_PRIVATE_KEY;
  if (!pk) throw new Error("RELAYER_PRIVATE_KEY is not set");

  const store = new JsonStore(
    process.env.RELAYER_STORE || path.join(__dirname, "data", "relayer.json")
  );

  const dests: DestChain[] = [];
  for (const [key, chain] of Object.entries(cfg.chains)) {
    const provider = new ethers.JsonRpcProvider(chain.rpcUrl);
    const network = await provider.getNetwork();
    if (network.chainId !== BigInt(chain.chainId)) {
      throw new Error(
        `RPC for '${key}' reports chain ${network.chainId}, config says ${chain.chainId} - refusing to run`
      );
    }
    const wallet = new ethers.Wallet(pk, provider);
    const bridge = new ethers.Contract(chain.bridge, BRIDGE_ABI, wallet);
    const registry = new ethers.Contract(await bridge.registry(), REGISTRY_ABI, provider);
    dests.push({
      key,
      chainId: BigInt(chain.chainId),
      bridge,
      registry,
      bridgeAddress: chain.bridge.toLowerCase(),
    });
    console.log(`Relaying to ${key} (chain ${chain.chainId}) as ${wallet.address}`);
  }

  async function fetchRecords(): Promise<Map<string, { message: SignatureRecord["message"]; sigs: string[] }>> {
    const byDigest = new Map<string, { message: SignatureRecord["message"]; sigs: string[] }>();
    for (const endpoint of cfg.relayer.validatorEndpoints) {
      try {
        const res = await fetch(`${endpoint}/messages`, { signal: AbortSignal.timeout(10000) });
        if (!res.ok) continue;
        const records = (await res.json()) as SignatureRecord[];
        for (const rec of records) {
          // Distrust the peer: the digest must be recomputable from the
          // message it claims to belong to.
          const message = msgFromJson(rec.message);
          if (computeDigest(message).toLowerCase() !== rec.digest.toLowerCase()) {
            console.warn(`Discarding tampered record from ${endpoint} (digest mismatch)`);
            continue;
          }
          const entry = byDigest.get(rec.digest) ?? { message: rec.message, sigs: [] };
          entry.sigs.push(rec.signature);
          byDigest.set(rec.digest, entry);
        }
      } catch (err) {
        console.warn(`Endpoint ${endpoint} unreachable:`, err instanceof Error ? err.message : err);
      }
    }
    return byDigest;
  }

  async function trySubmit(digest: string, entry: { message: SignatureRecord["message"]; sigs: string[] }) {
    if (store.isSubmitted(digest)) return;
    const message = msgFromJson(entry.message);

    const dest = dests.find(
      (d) => d.chainId === message.destChainId && d.bridgeAddress === message.bridge.toLowerCase()
    );
    if (!dest) return; // not a bridge we operate for

    if (await dest.bridge.processedMessages(digest)) {
      store.markSubmitted(digest, "already-processed");
      return;
    }
    if (await dest.bridge.paused()) {
      console.log(`[${dest.key}] bridge paused; holding ${digest}`);
      return;
    }

    // Membership and threshold come from the chain, not from config.
    const threshold = Number(await dest.registry.threshold());
    const validatorSet = new Set<string>();
    for (const sig of entry.sigs) {
      try {
        const signer = recoverSigner(message, sig).toLowerCase();
        if (await dest.registry.isValidator(signer)) validatorSet.add(signer);
      } catch {
        /* malformed signature - ignored */
      }
    }

    let quorum: string[];
    try {
      quorum = selectQuorum(message, entry.sigs, validatorSet, threshold);
    } catch (err) {
      console.log(`${digest}: ${err instanceof Error ? err.message : err}`);
      return; // wait for more validators to sign
    }

    const fn = message.action === ACTION_MINT ? "mintWrapped" : "releaseTokens";
    if (message.action !== ACTION_MINT && message.action !== ACTION_RELEASE) return;
    try {
      const tx = await dest.bridge[fn](message, quorum);
      console.log(`[${dest.key}] ${fn} nonce=${message.nonce} amount=${message.amount} tx=${tx.hash}`);
      const receipt = await tx.wait();
      if (receipt?.status === 1) {
        store.markSubmitted(digest, tx.hash);
      }
    } catch (err) {
      // Rate-limited, paused mid-flight, or out-of-gas: the message stays
      // unprocessed on-chain and will be retried on a later pass.
      console.warn(
        `[${dest.key}] ${fn} failed for ${digest} (will retry):`,
        err instanceof Error ? err.message : err
      );
    }
  }

  const interval = cfg.relayer.pollIntervalMs || 15000;
  for (;;) {
    try {
      const byDigest = await fetchRecords();
      for (const [digest, entry] of byDigest) {
        await trySubmit(digest, entry);
      }
    } catch (err) {
      console.error("relay pass error:", err instanceof Error ? err.message : err);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
