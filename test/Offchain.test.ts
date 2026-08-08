import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import type { HDNodeWallet } from "ethers";
import type {
  BridgedToken,
  MockERC20,
  Daraja,
  ValidatorRegistry,
} from "../typechain-types";
import {
  ACTION_MINT,
  ACTION_RELEASE,
  SourceEvent,
  buildMessage,
  chunkRanges,
  computeDigest,
  selectQuorum,
  signMessage,
} from "../offchain/lib";

// The hardhat network plays the DESTINATION chain; chain 97 is the claimed
// source. This exercises the exact pipeline the validator daemon runs:
// event -> buildMessage -> EIP-712 sign -> selectQuorum -> on-chain submit.
const SOURCE_CHAIN = 97n;

describe("off-chain validator pipeline", () => {
  async function deployFixture() {
    const [admin, user, guardian1, guardian2] = await ethers.getSigners();

    const validators: HDNodeWallet[] = Array.from({ length: 5 }, () =>
      ethers.Wallet.createRandom()
    ).sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1));
    const threshold = 3;
    const validatorSet = new Set(validators.map((v) => v.address.toLowerCase()));

    const registry = (await ethers.deployContract("ValidatorRegistry", [
      admin.address,
      validators.map((v) => v.address),
      threshold,
    ])) as unknown as ValidatorRegistry;
    const bridge = (await ethers.deployContract("Daraja", [
      admin.address,
      registry.target,
      [guardian1.address, guardian2.address],
      2,
    ])) as unknown as Daraja;
    const native = (await ethers.deployContract("MockERC20", [
      "Native",
      "NAT",
    ])) as unknown as MockERC20;
    const wrapped = (await ethers.deployContract("BridgedToken", [
      "Wrapped OEC", "wOEC", 18, bridge.target,
    ])) as unknown as BridgedToken;

    await bridge.registerToken(native.target, 1);
    await bridge.registerToken(wrapped.target, 2);
    await bridge.setSupportedChain(SOURCE_CHAIN, true);
    await bridge.setRateLimit(native.target, ethers.parseEther("1000"));
    await bridge.setRateLimit(wrapped.target, ethers.parseEther("1000"));

    const chainId = (await ethers.provider.getNetwork()).chainId;

    function makeEvent(overrides: Partial<SourceEvent> = {}): SourceEvent {
      return {
        kind: "TokensLocked",
        sourceChainId: SOURCE_CHAIN,
        nonce: 1n,
        token: "0x2b2FB8Df4ac5d394F0D5674d7A54802e42a06abA", // source-side token
        recipient: user.address,
        amount: ethers.parseEther("10"),
        destChainId: chainId,
        txHash: ethers.ZeroHash,
        logIndex: 0,
        ...overrides,
      };
    }

    return {
      admin, user, validators, threshold, validatorSet,
      registry, bridge, native, wrapped, chainId, makeEvent,
    };
  }

  it("a lock event signed off-chain mints on-chain through the full pipeline", async () => {
    const { bridge, wrapped, user, validators, validatorSet, threshold, makeEvent } =
      await loadFixture(deployFixture);

    const ev = makeEvent();
    const message = buildMessage(ev, bridge.target as string, wrapped.target as string);
    expect(message.action).to.equal(ACTION_MINT);

    // Three validators sign independently, in random arrival order.
    const sigs = await Promise.all(
      [validators[4], validators[0], validators[2]].map((v) => signMessage(v, message))
    );
    const quorum = selectQuorum(message, sigs, validatorSet, threshold);

    await expect(bridge.mintWrapped(message, quorum)).to.emit(bridge, "WrappedMinted");
    expect(await wrapped.balanceOf(user.address)).to.equal(ev.amount);
  });

  it("a burn event signed off-chain releases native on-chain", async () => {
    const { bridge, native, user, validators, validatorSet, threshold, makeEvent } =
      await loadFixture(deployFixture);

    // Give the bridge locked backing first.
    await native.mint(user.address, ethers.parseEther("50"));
    await native.connect(user).approve(bridge.target, ethers.parseEther("50"));
    await bridge.connect(user).lockTokens(native.target, ethers.parseEther("50"), SOURCE_CHAIN, user.address);

    const ev = makeEvent({ kind: "WrappedBurned", amount: ethers.parseEther("20"), nonce: 7n });
    const message = buildMessage(ev, bridge.target as string, native.target as string);
    expect(message.action).to.equal(ACTION_RELEASE);

    const sigs = await Promise.all(
      validators.slice(0, 3).map((v) => signMessage(v, message))
    );
    const quorum = selectQuorum(message, sigs, validatorSet, threshold);

    const before = await native.balanceOf(user.address);
    await bridge.releaseTokens(message, quorum);
    expect((await native.balanceOf(user.address)) - before).to.equal(ev.amount);
  });

  it("computes the same digest the contract's replay mapping uses", async () => {
    const { bridge, wrapped, validators, validatorSet, threshold, makeEvent } =
      await loadFixture(deployFixture);

    const message = buildMessage(makeEvent(), bridge.target as string, wrapped.target as string);
    const digest = computeDigest(message);

    expect(await bridge.processedMessages(digest)).to.equal(false);
    const sigs = await Promise.all(validators.slice(0, 3).map((v) => signMessage(v, message)));
    await bridge.mintWrapped(message, selectQuorum(message, sigs, validatorSet, threshold));
    expect(await bridge.processedMessages(digest)).to.equal(true);
  });

  it("selectQuorum deduplicates signers and filters non-validators", async () => {
    const { bridge, wrapped, validators, validatorSet, threshold, makeEvent } =
      await loadFixture(deployFixture);
    const message = buildMessage(makeEvent(), bridge.target as string, wrapped.target as string);

    const sigA = await signMessage(validators[0], message);
    const sigB = await signMessage(validators[1], message);
    const impostorSig = await signMessage(ethers.Wallet.createRandom(), message);

    // Two real signers, one duplicated, one impostor: only 2 distinct valid.
    expect(() =>
      selectQuorum(message, [sigA, sigB, sigA, impostorSig], validatorSet, threshold)
    ).to.throw("quorum not reached");
  });

  it("a message altered after signing produces a different digest and no quorum", async () => {
    const { bridge, wrapped, validators, validatorSet, threshold, makeEvent } =
      await loadFixture(deployFixture);
    const message = buildMessage(makeEvent(), bridge.target as string, wrapped.target as string);
    const sigs = await Promise.all(validators.slice(0, 3).map((v) => signMessage(v, message)));

    const tampered = { ...message, amount: message.amount * 2n };
    expect(computeDigest(tampered)).to.not.equal(computeDigest(message));
    // Recovery over the tampered message yields non-validator addresses.
    expect(() => selectQuorum(tampered, sigs, validatorSet, threshold)).to.throw(
      "quorum not reached"
    );
  });

  it("refuses to build messages the contract would reject", async () => {
    const { bridge, wrapped, makeEvent } = await loadFixture(deployFixture);
    const b = bridge.target as string;
    const w = wrapped.target as string;

    expect(() => buildMessage(makeEvent({ amount: 0n }), b, w)).to.throw("zero amount");
    expect(() =>
      buildMessage(makeEvent({ recipient: ethers.ZeroAddress }), b, w)
    ).to.throw("zero recipient");
    expect(() => buildMessage(makeEvent(), b, ethers.ZeroAddress)).to.throw(
      "zero destination address"
    );
    expect(() =>
      buildMessage(makeEvent({ destChainId: SOURCE_CHAIN }), b, w)
    ).to.throw("source equals destination");
  });

  it("chunks block ranges within public RPC getLogs limits", () => {
    expect(chunkRanges(0, 4999)).to.deep.equal([[0, 4999]]);
    expect(chunkRanges(100, 100)).to.deep.equal([[100, 100]]);
    expect(chunkRanges(0, 12000)).to.deep.equal([
      [0, 4999],
      [5000, 9999],
      [10000, 12000],
    ]);
    for (const [from, to] of chunkRanges(3, 50000)) {
      expect(to - from).to.be.lessThan(5000);
    }
  });
});
