# Daraja

Daraja (Swahili for "bridge") is Oeconomia's security-first lock-and-mint
cross-chain bridge, built to the requirements in `bridge-hardening-spec.md`.
Pre-audit, testnet-only build.

## Layout

- `contracts/Daraja.sol` - main bridge (lock/release native, mint/burn wrapped)
- `contracts/ValidatorRegistry.sol` - validator set + quorum verification, timelock-owned
- `contracts/BridgedToken.sol` - wrapped ERC-20, mintable only by the bridge
- `contracts/GuardianPausable.sol` - multi-party emergency pause
- `contracts/BridgeMessages.sol` - message format + strict field validation
- `contracts/BridgeTimelock.sol` - OpenZeppelin TimelockController import
- `offchain/validator.ts` - validator daemon: watches chains, signs messages, serves signatures
- `offchain/relayer.ts` - relayer daemon: aggregates quorums, submits to destination bridges
- `offchain/monitor.ts` - monitoring daemon: invariant watch, alerting, guardian auto-pause
- `offchain/monitorCore.ts` - the invariant checks themselves (local + cross-chain)
- `offchain/lib.ts` - shared message/signing/quorum logic (mirrors the contracts exactly)
- `site/` - standalone bridge web app (Vite + React + wagmi); also the source of
  truth for the frontend lib copied into Eloqura (see below)
- `SECURITY.md` - the hardening record / auditor handoff (read this first)

## Commands

```bash
npm install
npx hardhat test          # 46 tests (contracts + off-chain pipeline + monitor)
npx hardhat compile
npm run deploy:sepolia    # needs .env, see .env.example

# Off-chain services (after deployment):
cp offchain/config.example.json offchain/config.json   # fill in addresses
VALIDATOR_PRIVATE_KEY=0x... npm run validator          # one per validator
RELAYER_PRIVATE_KEY=0x...   npm run relayer            # any funded key
MONITOR_GUARDIAN_KEY=0x...  npm run monitor            # one per guardian
```

Each validator runs its own `validator` daemon with its own key and RPC
endpoints. The relayer polls every validator's read-only signature API
(`/messages`), assembles a quorum, and submits. Relayers are untrusted;
anyone can run one.

The monitor watches invariants and privileged events on every chain and
alerts (stdout, plus a webhook if `MONITOR_WEBHOOK_URL` is set). With a
guardian key it also responds on-chain: local violations trigger the
permissionless invariant check (which pauses the bridge itself), and
cross-chain supply divergence triggers a guardian `votePause` on both sides.
Pausing needs a guardian quorum (2+), so run at least two monitor instances
with different guardian keys for fully automated pausing. A keyless monitor
still alerts.

## How a transfer flows

1. User calls `lockTokens(token, amount, destChainId, recipient)` on chain A.
   The bridge credits only the balance it actually received.
2. Each validator daemon observes the `TokensLocked` event on its own RPC,
   waits `confirmations` blocks for finality, checks the token pair against
   its config allowlist, and signs an EIP-712 `BridgeMessage` (action = MINT)
   bound to the destination chain and bridge address.
3. The relayer collects signatures from validator APIs, verifies each one
   against the current on-chain validator set, and submits a sorted quorum to
   `mintWrapped` on chain B. The bridge re-checks fields, replay, quorum, and
   rate limit, then mints.
4. The reverse path burns wrapped on B (`burnWrapped`) and releases native on
   A (`releaseTokens`, action = RELEASE).

## Frontends

Two UIs share one frontend lib (`site/src/lib/bridge-{config,abi,core}.ts`):

- **Standalone site** (`site/`): `cd site && npm install && npm run dev`.
  Deploy with `npm run build` then `npx netlify deploy --prod --dir=dist`
  (netlify.toml included).
- **Eloqura bridge page**: `eloqura-claude-workspace/client/src/pages/bridge.tsx`
  uses copies of the same lib at `client/src/lib/bridge-*.ts`. Edit the site
  versions first, then copy over; keep them identical.

Both compute the transfer's EIP-712 digest from the lock/burn receipt and poll
the destination bridge's `processedMessages` until it lands, so status
tracking needs nothing but public RPC reads.

### After deploying contracts, update addresses in ALL of:

1. `offchain/config.json` (daemons)
2. `site/src/lib/bridge-config.ts` (standalone site): per-chain `bridge`
   address and the wrapped token addresses
3. `eloqura-claude-workspace/client/src/lib/bridge-config.ts` (same values)

The UIs stay in "Awaiting Testnet Deployment" mode while addresses are zero.

## Status

- [x] Contracts + hardening record (`SECURITY.md`)
- [x] Off-chain validator/signer service (`offchain/validator.ts`)
- [x] Relayer daemon (`offchain/relayer.ts`)
- [x] Monitoring daemon (`offchain/monitor.ts`): cross-chain invariant watch, alerting, guardian `votePause`
- [x] 46-test suite covering contracts, the off-chain pipeline, and the monitor
- [x] Standalone bridge site (`site/`) + Eloqura bridge page wired to the same contracts
- [ ] Testnet deployment (Sepolia <-> BSC testnet), then fill addresses into the three configs
- [ ] Netlify site creation for the standalone bridge
- [ ] Independent audit, public testnet period, bug bounty
