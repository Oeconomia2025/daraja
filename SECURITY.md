# Daraja - Hardening Record

This document is the written record required by `bridge-hardening-spec.md`
section 7: for each requirement, where it is enforced, which attacker inputs
were considered, and what tradeoffs were made. It is the handoff material for
the independent auditor. This build targets testnet only.

## 1. Architecture and Trust Model

**Design:** lock-and-mint. The same `Daraja` contract is deployed on
every chain. Each token is registered as `Native` (locked/released on this
chain) or `Wrapped` (minted/burned on this chain, as a `BridgedToken`).

**Trust model:** finality rests on an off-chain validator set. A message
executes on the destination chain only with EIP-712 signatures from at least
`threshold` distinct, current validators, where `threshold` is forced to be a
strict majority of the set (`ValidatorRegistry._setThreshold`). Forging a
withdrawal requires compromising a strict majority of validator keys. There is
no optimistic challenge window and no on-chain proof verification in this
build; the blast-radius controls in section 5 exist to bound the damage if the
validator assumption fails.

**State-changing functions and their invariants:**

| Function | Invariant before/after |
|---|---|
| `lockTokens` | `lockedBalance[t]` increases by exactly the tokens actually received; bridge token balance >= `lockedBalance[t]` |
| `releaseTokens` | message digest unprocessed before, processed after; `lockedBalance[t]` decreases by exactly `amount`; never below zero (checked math + explicit require) |
| `mintWrapped` | digest unprocessed before, processed after; `mintedSupply[t]` increases by `amount`; `totalSupply == mintedSupply` for a correctly configured BridgedToken |
| `burnWrapped` | `mintedSupply[t]` decreases by `amount`; reverts if it would underflow |
| `votePause` | pauses only when `pauseQuorum` distinct guardians voted within `PAUSE_VOTE_WINDOW` |
| registry/config setters | callable only by the timelock; set can never drop below quorum; threshold always a strict majority |

## 2. Message Verification and Integrity

**Deserialization (enforcement: Solidity ABI decoder + `BridgeMessages.validate`).**
Messages enter as ABI-typed calldata structs, so truncated, oversized, or
type-mismatched byte streams revert in the ABI decoder before any bridge code
runs. `BridgeMessages.validate` then rejects semantically hostile payloads:
wrong `action`, wrong `destChainId`, wrong `bridge` address, source chain equal
to this chain, zero token, zero recipient, zero amount. Inbound handlers
additionally require the source chain to be an approved counterparty and the
token to be registered for that exact path.

**Replay protection (enforcement: `processedMessages[digest]` check in
`releaseTokens` and `mintWrapped`, before any funds move).**
Chosen design: used-identifier mapping keyed by the EIP-712 digest, not strict
sequential nonces. Reason: sequential nonces stall the whole bridge if one
message is delayed or dropped; a mapping lets messages land out of order.
Uniqueness is airtight because the digest commits to every field including
`sourceChainId` and `nonce`, the source bridge assigns `nonce` from a strictly
increasing counter (`outboundNonce`), and the EIP-712 domain binds the digest
to this chain id and this bridge address. A message can never be accepted
twice: the flag is set in the same transaction that pays out, and it is
checked before the quorum check and before any transfer. Cross-path replay
(release message re-sent to the mint path) fails on the `action` field.
Cross-chain replay fails on the domain separator and `destChainId`.
Tests: "replay protection" suite.

**Signature and quorum enforcement (enforcement: `ValidatorRegistry.verifyQuorum`).**
- Count: at least `threshold` signatures required.
- Duplicates: recovered signers must be strictly ascending by address, so any
  repeated signer breaks the ordering and reverts. The same key can never be
  counted twice.
- Membership: every recovered address must be a current member of
  `isValidator`; a count alone never passes.
- Recovery: OpenZeppelin ECDSA rejects malleable s-values and invalid v, so a
  mangled signature reverts rather than recovering to a junk address, and a
  junk address would fail membership anyway.
- Bundle strictness: one bad signature rejects the whole bundle.

Paths by which a message reaches execution: exactly two, `releaseTokens` and
`mintWrapped`. Both call `validate`, then the replay check, then
`verifyQuorum` on the same digest the payout uses. There is no other code
path that moves bridge funds: `lockTokens`/`burnWrapped` only take funds in,
config functions are timelocked and cannot transfer, and the admin holds no
release or mint capability.

Attacker inputs considered and rejected: forged signatures (membership fails),
duplicate-signer padding (ordering fails), sub-threshold bundles (count
fails), tampered fields after signing (digest changes, recovery yields
non-members), messages for other chains or other bridge deployments (validate
fails), replays (processed mapping), validator keys removed from the set
(membership is checked against the current set at execution time).

## 3. Financial Invariants and State Ordering

**Arithmetic:** Solidity 0.8 checked arithmetic everywhere; no `unchecked`
blocks exist in the codebase.

**Supply invariant (enforcement points):**
- `releaseTokens`: explicit `require(amount <= lockedBalance[token])` plus the
  checked decrement. Reverts on-chain; not a test-only assertion.
- `burnWrapped`: `require(mintedSupply[token] >= amount)`.
- `mintWrapped`: the cross-chain half of the invariant (wrapped minted on the
  destination never exceeds native locked on the source) is not readable
  on-chain from the destination. Its enforceable local projection: wrapped
  supply changes only through quorum-verified mints, every mint consumes rate
  limit, and `checkWrappedInvariant` pauses the bridge if `totalSupply` ever
  exceeds `mintedSupply` (evidence of minting outside the bridge). This gap is
  inherent to lock-and-mint designs and is stated here deliberately.

**Effects before interactions:** in `releaseTokens` and `mintWrapped`, the
processed flag, balance/supply accounting, and rate-limit spend all settle
before the external transfer or mint, which is the last operation.
`burnWrapped` settles accounting before calling `burnFrom`. The single
exception is `lockTokens`, where the token transfer must precede the effects
because the amount credited is the measured balance delta (fee-on-transfer
safety). That path is `nonReentrant`, tokens are only registered through the
timelock, and no state is read after the interaction that the token could
have manipulated.

**Reentrancy:** every function that makes an external call (`lockTokens`,
`releaseTokens`, `mintWrapped`, `burnWrapped`) carries `nonReentrant` in
addition to correct ordering.

**Non-standard tokens:** `lockTokens` credits the before/after balance delta,
never the stated amount, so fee-on-transfer tokens cannot inflate
`lockedBalance` (test: fee token credits 99 for a 100 send). Rebasing tokens
remain unsupported: a negative rebase makes the backing fall below
`lockedBalance`, which `checkNativeInvariant` treats as a violation and
pauses. The supported-token set is therefore explicitly restricted to
timelock-registered, non-rebasing ERC-20s, and that restriction is this
paragraph's documented policy.

## 4. Access Control and Configuration

**Privilege map:**

| Capability | Function(s) | Who | Enforcement |
|---|---|---|---|
| Move locked funds | `releaseTokens` | validator quorum only (caller is irrelevant) | `verifyQuorum` |
| Mint wrapped | `mintWrapped` -> `BridgedToken.mint` | validator quorum; token accepts only the bridge address (immutable) | `verifyQuorum`; `msg.sender == bridge` |
| Burn wrapped | `burnWrapped` | any user, own funds via allowance | ERC-20 allowance |
| Pause | `votePause` | guardian council, `pauseQuorum` distinct votes | `onlyGuardian` + round accounting |
| Unpause | `unpause` | timelock | `onlyRole(DEFAULT_ADMIN_ROLE)` |
| Register tokens/chains, rate limits, thresholds, guardian set | `registerToken`, `setSupportedChain`, `setRateLimit`, `setLargeOutflowThreshold`, `addGuardian`, `removeGuardian`, `setPauseQuorum` | timelock | `onlyRole(DEFAULT_ADMIN_ROLE)` |
| Validator set and threshold | `addValidator`, `removeValidator`, `setThreshold` | timelock | `onlyOwner` (owner is the timelock, `Ownable2Step`) |
| Upgrade | none | nobody | contracts are not upgradeable |
| Move admin funds | none | nobody | no such function exists |

Nothing is reachable by an address that should not reach it: there is no
owner-withdraw, no arbitrary-call escape hatch, and no upgrade slot.

**Role segregation:** the timelock configures but cannot move funds (no
release/mint path accepts admin authority). Validators authorize fund movement
but hold zero on-chain call rights and cannot touch configuration. Guardians
can only halt. Relayers are permissionless and hold no authority. No single
role can both change configuration and move funds.

**Timelock:** the registry owner and the bridge admin are a stock
OpenZeppelin `TimelockController`. Every configuration change, validator-set
change, and unpause is scheduled publicly and cannot execute before the delay.
There is no bypass path: the roles are granted only to the timelock at
construction. The contracts are non-upgradeable, so implementation-upgrade
timelocking is satisfied vacuously.

**Initialization audit:** `ValidatorRegistry`'s constructor rejects an empty
set, zero addresses, duplicates, and any non-majority threshold, so a
zero-value signer configuration cannot exist. The bridge constructor rejects a
zero timelock, zero registry, and an uninitialized registry, and
`_initGuardians` rejects an empty or duplicate guardian set and a quorum
below 2. `DEFAULT_ADMIN_ROLE` is granted to the timelock in the constructor,
so no privileged role is left unclaimed, and the deployer retains nothing.
Messages are validated against explicit registrations (`tokenType`,
`supportedChains`), which default to None/false, so unset state is never
treated as valid.

## 5. Blast-Radius Controls

**Outflow rate limit (`_consumeRateLimit`, called from both inbound paths):**
per-token cap per fixed 6-hour window. Fail closed: a token with no
configured limit cannot flow out at all. When the cap is reached the
transaction reverts and the message remains unprocessed; anyone can resubmit
the same signed message in a later window, so a capped message is delayed,
never lost. Tradeoff stated: safety over liveness; a validator-compromise
drain is bounded to `maxPerWindow` per token per window, at the cost of
legitimate large transfers queueing across windows.

**Emergency pause:** multi-party by construction. `pauseQuorum >= 2` distinct
guardians must vote within a 1-hour window; stale votes expire. No single key
can halt the bridge, and a malicious guardian quorum can only freeze, never
move, funds. Unpausing requires the timelock, so recovery from a bad pause is
slow and public while entering a pause is fast. The pause halts all message
parsing and state modification: both inbound handlers, both outbound
handlers.

**Invariant-triggered pause:** `checkNativeInvariant` and
`checkWrappedInvariant` are permissionless. If the bridge's token balance
falls below `lockedBalance`, or a wrapped token's `totalSupply` exceeds
`mintedSupply`, the bridge pauses itself in the same transaction and emits
`InvariantViolation`. Any watcher, including the off-chain monitor, can
trigger this with no privileges.

**Monitoring hooks:** every fund movement emits an event
(`TokensLocked`, `TokensReleased`, `WrappedMinted`, `WrappedBurned`);
outflows at or above the per-token threshold additionally emit
`LargeOutflow`; every privileged call emits its own event
(`TokenRegistered`, `ChainSupportSet`, `RateLimitSet`,
`LargeOutflowThresholdSet`, `GuardianAdded/Removed`, `PauseQuorumChanged`,
`ValidatorAdded/Removed`, `ThresholdChanged`); invariant deviations emit
`InvariantViolation`.

## 6. Standard Hygiene Checklist

- `tx.origin`: not used anywhere.
- Price/oracle dependence: none; the bridge transfers exact signed amounts
  and never consults a price or another protocol's manipulable state.
- Arithmetic: all checked; zero `unchecked` blocks.
- External calls: isolated to token transfer/mint/burn operations, guarded by
  `nonReentrant`, and last in each function except the measured
  `transferFrom` in `lockTokens` (justified in section 3).

## Off-Chain Services (offchain/)

The validator daemon signs only events it read from its own configured RPC
after the per-chain confirmation depth, only for token pairs in its explicit
config allowlist, and refuses to start if an RPC's reported chain id
disagrees with config. Its HTTP API is read-only; signatures are public
material, bound by the EIP-712 domain to one action on one bridge on one
chain, and useless below quorum. Nothing received over the network is ever
signed. Signing is deterministic, so restarts and re-scans are idempotent,
and the block watermark advances only after signatures are persisted (crash
means re-scan, never skip).

The relayer is untrusted by design and verifies anyway before spending gas:
it recomputes every digest from the peer-served message (tampered records
are discarded), recovers every signature, checks membership against the
current on-chain validator set, reads the threshold from the chain rather
than config, and skips processed digests. A submission that fails (rate
limit, pause) leaves the message unprocessed on-chain and is retried.

The monitor daemon closes the cross-chain gap documented in section 3: it
continuously compares `lockedBalance` on each source chain with
`mintedSupply` on the matching destination chain. Ordering makes this check
false-positive free: locks precede mints and burns precede releases, so a
healthy bridge always satisfies minted <= locked, and any observation of
minted > locked is a genuine violation regardless of in-flight messages. It
also evaluates the local invariants off-chain every cycle (free reads) and,
on a real violation, submits the permissionless on-chain check so the bridge
pauses itself. For cross-chain divergence, which no contract can compute, it
casts a guardian `votePause` on both sides of the pair. One monitor holds at
most one guardian key, and pausing requires a guardian quorum, so a
compromised monitor cannot freeze the bridge alone; two independent monitor
instances with distinct keys give fully automated pausing. It additionally
scans and alerts on every privileged-configuration event on the bridge and
registry, every pause action, invariant violations, and large outflows,
with optional webhook delivery.

## Verification Status

46 passing tests (`npx hardhat test`). Contract coverage: quorum forgery attempts
(duplicate signer, non-member signer, sub-threshold, tampered fields), replay
in both paths, field validation, supply invariant enforcement, fee-on-transfer
measurement, rate-limit cap and fail-closed behavior, multi-party pause
mechanics and vote expiry, invariant auto-pause for both token classes,
access control on every configuration function, and the full timelock
schedule/execute flow. Off-chain pipeline coverage: end-to-end lock-to-mint
and burn-to-release flows using the daemon's own build/sign/aggregate code
against the real contracts, digest equality with the on-chain replay mapping,
quorum deduplication and impostor filtering, tamper detection, refusal to
sign contract-rejectable messages, and getLogs chunking limits. Monitor
coverage: drained-backing detection, rogue wrapped-mint detection,
user-burn tolerance (supply below minted is harmless), cross-chain
minted-exceeds-locked detection across two live bridge deployments, and the
detect-then-pause response sequence.

## Known Limitations (for the auditor)

1. Validator majority compromise defeats the trust model by design; rate
   limits and pause bound but do not prevent losses in that case.
2. The cross-chain supply invariant is enforced per-side on-chain and
   globally by the monitor daemon (`offchain/monitor.ts`), which compares
   `lockedBalance` (source) with `mintedSupply` (destination) continuously
   and votes to pause on divergence. At least two monitor instances with
   distinct guardian keys must be running for automated pausing.
3. No relayer incentive layer; message delivery relies on interested parties.
4. Guardian and validator liveness assumptions: losing quorum-many guardian
   keys removes fast-pause; losing majority validator keys halts the bridge
   (funds remain locked until the timelock rotates the set).
5. Independent audit, public testnet period, and a bug bounty are still
   required before this bridge holds real value.
