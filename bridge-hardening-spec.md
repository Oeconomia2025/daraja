# Cross-Chain Bridge — Security-First Engineering Specification

## Purpose and Working Method

This is a security-critical smart contract intended to hold locked user
funds. This document is a pre-audit hardening specification: it defines the
defensive requirements the implementation must satisfy *before* the contract
is submitted for independent audit. It does not replace an audit.

For every requirement below, do two things:

1. **Implement it.**
2. **Demonstrate it.** Show the exact code path that enforces the requirement,
   and explicitly enumerate how an attacker-controlled input is rejected.

Treat every external input, every cross-chain message, and every caller as
hostile until proven otherwise. Where a requirement involves a safety-versus-
liveness tradeoff, state the tradeoff explicitly rather than silently choosing
one side.

Work in passes, one concern per pass. After each pass, produce a short written
summary of what is now enforced and where. That written record is also the
material handed to the auditor.

---

## 1. Architecture and Trust Model

- State the bridge's trust model up front: what convinces the destination
  chain that an event on the source chain really happened? Document whether
  finality rests on an off-chain validator/signer set, an optimistic challenge
  window, or on-chain proof verification, and document exactly how many keys or
  parties must be compromised to forge a withdrawal.
- Every module must be optimized for explicit data validation, deterministic
  state transitions, and predictable execution ordering.
- Enumerate every state-changing function. For each, write the invariant that
  must hold before and after execution.

## 2. Message Verification and Integrity

- **Deserialization checks:** Enforce exhaustive serialization and
  deserialization validation on all incoming cross-chain messages. Apply strict
  length and type checking on byte streams before any execution. Reject any
  malformed payload immediately.
- **Replay protection:** Maintain an on-chain record of processed message
  identifiers, checked *before* any funds move. Decide deliberately between
  strict per-domain sequential nonces (safer against replay, but can stall the
  bridge if a message is skipped or arrives out of order) and a used-identifier
  mapping (more permissive, requires airtight uniqueness). State which was
  chosen and why. Prove no message can be both accepted and later re-accepted.
- **Signature and quorum enforcement:** Require an explicit quorum of the
  approved validator set. In addition to counting signatures:
  - Reject duplicate signers within a single quorum (a repeated signer must not
    be counted toward the threshold more than once).
  - Verify each signature recovers to an address that is actually a current
    member of the approved set, not merely that a count was met.
  - Confirm the validator set itself cannot be silently replaced (see §4).
  - Show every code path by which a message reaches execution, and prove a
    forged or duplicate-signer quorum cannot pass.

## 3. Financial Invariants and State Ordering

- **Arithmetic safety:** Use built-in compiler overflow/underflow protection
  (or explicit checked wrappers) for all balance manipulations.
- **Supply invariant:** Total minted/wrapped assets on the destination must
  never exceed the verified locked native assets on the source, at any block
  height. Enforce this as an on-chain check that reverts on violation, not
  merely as a test assertion. Show the enforcement point in every mint and
  every release path.
- **Effects before interactions:** Native token locking must fully settle and
  update contract state *before* any external cross-chain notification is
  dispatched. Follow checks-effects-interactions ordering throughout.
- **Reentrancy:** Apply an explicit reentrancy guard to every function that
  makes an external call, in addition to correct ordering.
- **Non-standard tokens:** If arbitrary ERC-20s are accepted, measure the
  actual received balance via before/after balance comparison rather than
  trusting the stated transfer amount, so fee-on-transfer and rebasing tokens
  cannot silently break the supply invariant. Alternatively, restrict the
  supported token set explicitly and document that restriction.

## 4. Access Control and Configuration

- **Privilege map:** List every function that can mint, burn, pause, upgrade,
  move admin funds, or change the validator/signer set. For each, show who can
  call it and the access-control modifier that enforces it. Flag anything
  reachable by an address that should not reach it.
- **Role segregation:** Apply role-based access control with granular,
  non-overlapping operational roles. No single role should be able to both
  change configuration and move funds without a second control.
- **Timelock on configuration:** Mandate an un-bypassable timelock window for
  any configuration change, validator-set change, or implementation upgrade, so
  a malicious or mistaken change is observable before it takes effect.
- **Initialization audit:** Audit the constructor and any initializer. Prove no
  uninitialized or zero-value state (message roots, signer sets, admin
  addresses) is ever treated as valid, and that no privileged role is left
  unclaimed after deployment.

## 5. Blast-Radius Controls

- **Outflow rate limit:** Cap the total value that can exit the bridge per time
  window. Show the implementation and walk through what happens when the cap is
  reached. This limits losses even against bugs not found before audit.
- **Emergency pause:** Integrate a pause mechanism, guarded by a multi-party
  role (not a single key), that halts all message parsing and state
  modification. It must trigger on any computed invariant discrepancy.
- **Monitoring hooks:** Emit events on large or unusual withdrawals, on every
  privileged-function call, and on any invariant deviation, so off-chain
  monitoring can alert in real time and trigger the pause if needed.

## 6. Standard Hygiene Checklist

- No reliance on `tx.origin` for authorization.
- No dependence on manipulable external state or spot price where an attacker
  can influence it within a transaction.
- All arithmetic checked; no unchecked blocks around balance math without a
  proven-safe justification.
- External calls isolated, guarded, and last in each function.

## 7. Deliverables Per Pass

For each of §2 through §6, return:

1. The implemented code.
2. The specific enforcement point(s) for each requirement.
3. An explicit enumeration of the attacker inputs considered and how each is
   rejected.
4. Any safety/liveness tradeoff encountered and the decision made.

This spec targets a testnet-ready build. Independent audit, a public testnet
period, and a bug bounty remain required before the bridge holds real value.
