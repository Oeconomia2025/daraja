import { expect } from "chai";
import { ethers, network } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import type { HDNodeWallet } from "ethers";
import type {
  BridgedToken,
  MockERC20,
  MockFeeToken,
  MockRuggableToken,
  OeconomiaBridge,
  TimelockController,
  ValidatorRegistry,
} from "../typechain-types";

// Actions must match BridgeMessages.sol
const ACTION_RELEASE = 1;
const ACTION_MINT = 2;

const REMOTE_CHAIN = 97n; // pretend BSC testnet is the counterparty
const RATE_WINDOW = 6 * 60 * 60;

const EIP712_TYPES = {
  BridgeMessage: [
    { name: "action", type: "uint8" },
    { name: "sourceChainId", type: "uint256" },
    { name: "destChainId", type: "uint256" },
    { name: "bridge", type: "address" },
    { name: "token", type: "address" },
    { name: "recipient", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
};

interface Message {
  action: number;
  sourceChainId: bigint;
  destChainId: bigint;
  bridge: string;
  token: string;
  recipient: string;
  amount: bigint;
  nonce: bigint;
}

describe("OeconomiaBridge", () => {
  async function deployFixture() {
    const [admin, user, recipient, guardian1, guardian2, guardian3, outsider] =
      await ethers.getSigners();

    // Five validator keys, sorted ascending by address so signature bundles
    // can satisfy the registry's strict-ordering rule.
    const validators: HDNodeWallet[] = Array.from({ length: 5 }, () =>
      ethers.Wallet.createRandom()
    ).sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1));
    const threshold = 3;

    // `admin` stands in for the TimelockController in unit tests; the
    // dedicated timelock suite below proves the delayed path end to end.
    const registry = (await ethers.deployContract("ValidatorRegistry", [
      admin.address,
      validators.map((v) => v.address),
      threshold,
    ])) as unknown as ValidatorRegistry;

    const bridge = (await ethers.deployContract("OeconomiaBridge", [
      admin.address,
      registry.target,
      [guardian1.address, guardian2.address, guardian3.address],
      2,
    ])) as unknown as OeconomiaBridge;

    const native = (await ethers.deployContract("MockERC20", [
      "Native",
      "NAT",
    ])) as unknown as MockERC20;
    const feeToken = (await ethers.deployContract("MockFeeToken")) as unknown as MockFeeToken;
    const wrapped = (await ethers.deployContract("BridgedToken", [
      "Wrapped OEC",
      "wOEC",
      18,
      bridge.target,
    ])) as unknown as BridgedToken;

    await bridge.registerToken(native.target, 1); // Native
    await bridge.registerToken(feeToken.target, 1); // Native
    await bridge.registerToken(wrapped.target, 2); // Wrapped
    await bridge.setSupportedChain(REMOTE_CHAIN, true);
    await bridge.setRateLimit(native.target, ethers.parseEther("1000"));
    await bridge.setRateLimit(wrapped.target, ethers.parseEther("1000"));
    await bridge.setLargeOutflowThreshold(native.target, ethers.parseEther("500"));

    await native.mint(user.address, ethers.parseEther("10000"));
    await feeToken.mint(user.address, ethers.parseEther("10000"));

    const chainId = (await ethers.provider.getNetwork()).chainId;
    const domain = {
      name: "OeconomiaBridge",
      version: "1",
      chainId,
      verifyingContract: bridge.target as string,
    };

    let nextNonce = 0n;
    function makeMessage(overrides: Partial<Message> = {}): Message {
      nextNonce += 1n;
      return {
        action: ACTION_RELEASE,
        sourceChainId: REMOTE_CHAIN,
        destChainId: chainId,
        bridge: bridge.target as string,
        token: native.target as string,
        recipient: recipient.address,
        amount: ethers.parseEther("10"),
        nonce: nextNonce,
        ...overrides,
      };
    }

    /// Signs with the given validator wallets, sorted ascending by address.
    async function sign(message: Message, signers: HDNodeWallet[] = validators.slice(0, threshold)) {
      const ordered = [...signers].sort((a, b) =>
        BigInt(a.address) < BigInt(b.address) ? -1 : 1
      );
      return Promise.all(ordered.map((w) => w.signTypedData(domain, EIP712_TYPES, message)));
    }

    /// Locks native so the bridge has backing to release in tests.
    async function fundLocked(amount: bigint) {
      await native.connect(user).approve(bridge.target, amount);
      await bridge.connect(user).lockTokens(native.target, amount, REMOTE_CHAIN, user.address);
    }

    return {
      admin, user, recipient, guardian1, guardian2, guardian3, outsider,
      validators, threshold, registry, bridge, native, feeToken, wrapped,
      chainId, domain, makeMessage, sign, fundLocked,
    };
  }

  // =================================================================
  // Section 2 - message verification and integrity
  // =================================================================

  describe("quorum enforcement", () => {
    it("releases with a valid quorum of current validators", async () => {
      const { bridge, native, recipient, makeMessage, sign, fundLocked } =
        await loadFixture(deployFixture);
      await fundLocked(ethers.parseEther("100"));

      const m = makeMessage();
      await expect(bridge.releaseTokens(m, await sign(m)))
        .to.emit(bridge, "TokensReleased");
      expect(await native.balanceOf(recipient.address)).to.equal(m.amount);
    });

    it("rejects a quorum containing a duplicated signer", async () => {
      const { bridge, validators, makeMessage, sign, fundLocked } =
        await loadFixture(deployFixture);
      await fundLocked(ethers.parseEther("100"));

      const m = makeMessage();
      // Two distinct validators + one of them repeated = 3 signatures, 2 keys.
      const [sigA, sigB] = await sign(m, [validators[0], validators[1]]);
      await expect(
        bridge.releaseTokens(m, [sigA, sigB, sigB])
      ).to.be.revertedWith("Registry: unsorted or duplicate signer");
    });

    it("rejects signatures from keys outside the validator set", async () => {
      const { bridge, validators, makeMessage, sign, fundLocked } =
        await loadFixture(deployFixture);
      await fundLocked(ethers.parseEther("100"));

      const m = makeMessage();
      const impostor = ethers.Wallet.createRandom();
      const sigs = await sign(m, [validators[0], validators[1], impostor]);
      await expect(bridge.releaseTokens(m, sigs)).to.be.revertedWith(
        "Registry: signer not in validator set"
      );
    });

    it("rejects fewer signatures than the threshold", async () => {
      const { bridge, validators, makeMessage, sign, fundLocked } =
        await loadFixture(deployFixture);
      await fundLocked(ethers.parseEther("100"));

      const m = makeMessage();
      const sigs = await sign(m, [validators[0], validators[1]]);
      await expect(bridge.releaseTokens(m, sigs)).to.be.revertedWith(
        "Registry: insufficient signatures"
      );
    });

    it("rejects a message whose fields were tampered with after signing", async () => {
      const { bridge, makeMessage, sign, fundLocked } = await loadFixture(deployFixture);
      await fundLocked(ethers.parseEther("100"));

      const m = makeMessage();
      const sigs = await sign(m);
      const tampered = { ...m, amount: ethers.parseEther("99") };
      // Recovery over the altered digest yields addresses that are not
      // validators (or breaks ordering) - either way it reverts.
      await expect(bridge.releaseTokens(tampered, sigs)).to.be.reverted;
    });
  });

  describe("replay protection", () => {
    it("permanently rejects an already-processed message", async () => {
      const { bridge, makeMessage, sign, fundLocked } = await loadFixture(deployFixture);
      await fundLocked(ethers.parseEther("100"));

      const m = makeMessage();
      const sigs = await sign(m);
      await bridge.releaseTokens(m, sigs);
      await expect(bridge.releaseTokens(m, sigs)).to.be.revertedWith(
        "Bridge: message already processed"
      );
    });

    it("rejects a release replayed into the mint path", async () => {
      const { bridge, wrapped, makeMessage, sign, fundLocked } =
        await loadFixture(deployFixture);
      await fundLocked(ethers.parseEther("100"));

      const m = makeMessage(); // ACTION_RELEASE
      await bridge.releaseTokens(m, await sign(m));
      await expect(
        bridge.mintWrapped({ ...m, token: wrapped.target as string }, await sign(m))
      ).to.be.revertedWith("BridgeMessages: wrong action");
    });
  });

  describe("strict field validation", () => {
    it("rejects a message addressed to a different chain", async () => {
      const { bridge, makeMessage, sign } = await loadFixture(deployFixture);
      const m = makeMessage({ destChainId: 999n });
      await expect(bridge.releaseTokens(m, await sign(m))).to.be.revertedWith(
        "BridgeMessages: wrong destination chain"
      );
    });

    it("rejects a message addressed to a different bridge contract", async () => {
      const { bridge, outsider, makeMessage, sign } = await loadFixture(deployFixture);
      const m = makeMessage({ bridge: outsider.address });
      await expect(bridge.releaseTokens(m, await sign(m))).to.be.revertedWith(
        "BridgeMessages: wrong bridge address"
      );
    });

    it("rejects zero recipient, zero amount, and unknown source chain", async () => {
      const { bridge, makeMessage, sign } = await loadFixture(deployFixture);

      const zeroRecipient = makeMessage({ recipient: ethers.ZeroAddress });
      await expect(
        bridge.releaseTokens(zeroRecipient, await sign(zeroRecipient))
      ).to.be.revertedWith("BridgeMessages: zero recipient");

      const zeroAmount = makeMessage({ amount: 0n });
      await expect(
        bridge.releaseTokens(zeroAmount, await sign(zeroAmount))
      ).to.be.revertedWith("BridgeMessages: zero amount");

      const badSource = makeMessage({ sourceChainId: 12345n });
      await expect(
        bridge.releaseTokens(badSource, await sign(badSource))
      ).to.be.revertedWith("Bridge: unsupported source chain");
    });

    it("rejects tokens not registered for the requested path", async () => {
      const { bridge, wrapped, makeMessage, sign } = await loadFixture(deployFixture);
      // A wrapped token cannot go through the native release path.
      const m = makeMessage({ token: wrapped.target as string });
      await expect(bridge.releaseTokens(m, await sign(m))).to.be.revertedWith(
        "Bridge: token not registered as native"
      );
    });
  });

  // =================================================================
  // Section 3 - financial invariants
  // =================================================================

  describe("supply invariant", () => {
    it("never releases more than the locked balance", async () => {
      const { bridge, makeMessage, sign, fundLocked } = await loadFixture(deployFixture);
      await fundLocked(ethers.parseEther("50"));

      const m = makeMessage({ amount: ethers.parseEther("51") });
      await expect(bridge.releaseTokens(m, await sign(m))).to.be.revertedWith(
        "Bridge: release exceeds locked balance"
      );
    });

    it("credits only the amount actually received from fee-on-transfer tokens", async () => {
      const { bridge, feeToken, user } = await loadFixture(deployFixture);
      await bridge.setRateLimit(feeToken.target, ethers.parseEther("1000"));

      const sent = ethers.parseEther("100");
      await feeToken.connect(user).approve(bridge.target, sent);
      await expect(
        bridge.connect(user).lockTokens(feeToken.target, sent, REMOTE_CHAIN, user.address)
      )
        .to.emit(bridge, "TokensLocked")
        .withArgs(1n, feeToken.target, user.address, user.address, ethers.parseEther("99"), REMOTE_CHAIN);
      expect(await bridge.lockedBalance(feeToken.target)).to.equal(ethers.parseEther("99"));
    });

    it("tracks wrapped minted supply and burns against it", async () => {
      const { bridge, wrapped, user, makeMessage, sign } = await loadFixture(deployFixture);

      const m = makeMessage({
        action: ACTION_MINT,
        token: wrapped.target as string,
        recipient: user.address,
        amount: ethers.parseEther("40"),
      });
      await bridge.mintWrapped(m, await sign(m));
      expect(await bridge.mintedSupply(wrapped.target)).to.equal(ethers.parseEther("40"));
      expect(await wrapped.totalSupply()).to.equal(ethers.parseEther("40"));

      await wrapped.connect(user).approve(bridge.target, ethers.parseEther("15"));
      await bridge
        .connect(user)
        .burnWrapped(wrapped.target, ethers.parseEther("15"), REMOTE_CHAIN, user.address);
      expect(await bridge.mintedSupply(wrapped.target)).to.equal(ethers.parseEther("25"));
      expect(await wrapped.totalSupply()).to.equal(ethers.parseEther("25"));
    });

    it("only the bridge can mint the wrapped token", async () => {
      const { wrapped, outsider } = await loadFixture(deployFixture);
      await expect(
        wrapped.connect(outsider).mint(outsider.address, 1n)
      ).to.be.revertedWith("BridgedToken: caller is not the bridge");
    });
  });

  // =================================================================
  // Section 5 - blast-radius controls
  // =================================================================

  describe("outflow rate limit", () => {
    it("blocks outflow beyond the per-window cap and resumes next window", async () => {
      const { bridge, makeMessage, sign, fundLocked } = await loadFixture(deployFixture);
      await fundLocked(ethers.parseEther("2000"));

      const first = makeMessage({ amount: ethers.parseEther("900") });
      await bridge.releaseTokens(first, await sign(first));

      const second = makeMessage({ amount: ethers.parseEther("200") });
      const sigs = await sign(second);
      await expect(bridge.releaseTokens(second, sigs)).to.be.revertedWith(
        "Bridge: rate limit exceeded"
      );

      // Safety over liveness: the message was NOT consumed - after the
      // window rolls, the same signed message goes through.
      await time.increase(RATE_WINDOW + 1);
      await expect(bridge.releaseTokens(second, sigs)).to.emit(bridge, "TokensReleased");
    });

    it("fails closed when no rate limit is configured", async () => {
      const { bridge, admin, user, makeMessage, sign } = await loadFixture(deployFixture);
      const bare = (await ethers.deployContract("MockERC20", [
        "Bare",
        "BARE",
      ])) as unknown as MockERC20;
      await bridge.registerToken(bare.target, 1);
      await bare.mint(user.address, ethers.parseEther("10"));
      await bare.connect(user).approve(bridge.target, ethers.parseEther("10"));
      await bridge.connect(user).lockTokens(bare.target, ethers.parseEther("10"), REMOTE_CHAIN, user.address);

      const m = makeMessage({ token: bare.target as string, amount: ethers.parseEther("1") });
      await expect(bridge.releaseTokens(m, await sign(m))).to.be.revertedWith(
        "Bridge: rate limit not configured"
      );
    });

    it("emits LargeOutflow at or above the alert threshold", async () => {
      const { bridge, recipient, makeMessage, sign, fundLocked } =
        await loadFixture(deployFixture);
      await fundLocked(ethers.parseEther("1000"));

      const m = makeMessage({ amount: ethers.parseEther("500") });
      await expect(bridge.releaseTokens(m, await sign(m)))
        .to.emit(bridge, "LargeOutflow")
        .withArgs(m.token, recipient.address, m.amount);
    });
  });

  describe("guardian pause", () => {
    it("requires two distinct guardians; one is never enough", async () => {
      const { bridge, guardian1, guardian2 } = await loadFixture(deployFixture);
      await bridge.connect(guardian1).votePause();
      expect(await bridge.paused()).to.equal(false);
      await bridge.connect(guardian2).votePause();
      expect(await bridge.paused()).to.equal(true);
    });

    it("rejects non-guardians and double votes", async () => {
      const { bridge, guardian1, outsider } = await loadFixture(deployFixture);
      await expect(bridge.connect(outsider).votePause()).to.be.revertedWith(
        "Guardian: caller is not a guardian"
      );
      await bridge.connect(guardian1).votePause();
      await expect(bridge.connect(guardian1).votePause()).to.be.revertedWith(
        "Guardian: already voted this round"
      );
    });

    it("expires stale votes so old and new votes cannot combine", async () => {
      const { bridge, guardian1, guardian2 } = await loadFixture(deployFixture);
      await bridge.connect(guardian1).votePause();
      await time.increase(3700); // beyond PAUSE_VOTE_WINDOW
      await bridge.connect(guardian2).votePause(); // starts a NEW round
      expect(await bridge.paused()).to.equal(false);
    });

    it("halts all fund movement when paused; only admin can unpause", async () => {
      const { bridge, native, user, guardian1, guardian2, makeMessage, sign } =
        await loadFixture(deployFixture);
      await bridge.connect(guardian1).votePause();
      await bridge.connect(guardian2).votePause();

      await native.connect(user).approve(bridge.target, 1n);
      await expect(
        bridge.connect(user).lockTokens(native.target, 1n, REMOTE_CHAIN, user.address)
      ).to.be.revertedWithCustomError(bridge, "EnforcedPause");
      const m = makeMessage({ amount: 1n });
      await expect(bridge.releaseTokens(m, await sign(m))).to.be.revertedWithCustomError(
        bridge,
        "EnforcedPause"
      );

      await expect(bridge.connect(guardian1).unpause()).to.be.reverted;
      await bridge.unpause();
      expect(await bridge.paused()).to.equal(false);
    });
  });

  describe("invariant auto-pause", () => {
    it("pauses the bridge when native backing falls below the locked balance", async () => {
      const { bridge, user } = await loadFixture(deployFixture);
      const rug = (await ethers.deployContract(
        "MockRuggableToken"
      )) as unknown as MockRuggableToken;
      await bridge.registerToken(rug.target, 1);
      await bridge.setRateLimit(rug.target, ethers.parseEther("1000"));
      await rug.mint(user.address, ethers.parseEther("100"));
      await rug.connect(user).approve(bridge.target, ethers.parseEther("100"));
      await bridge.connect(user).lockTokens(rug.target, ethers.parseEther("100"), REMOTE_CHAIN, user.address);

      // Simulate the backing being drained out from under the bridge.
      await rug.destroy(bridge.target, ethers.parseEther("40"));

      await expect(bridge.checkNativeInvariant(rug.target))
        .to.emit(bridge, "InvariantViolation")
        .withArgs(rug.target, ethers.parseEther("100"), ethers.parseEther("60"));
      expect(await bridge.paused()).to.equal(true);
    });

    it("pauses when wrapped supply exceeds what this bridge minted", async () => {
      const { bridge, outsider } = await loadFixture(deployFixture);
      // Misconfigured wrapped token whose minter is an EOA, not the bridge.
      const rogue = (await ethers.deployContract("BridgedToken", [
        "Rogue", "RGE", 18, outsider.address,
      ])) as unknown as BridgedToken;
      await bridge.registerToken(rogue.target, 2);
      await rogue.connect(outsider).mint(outsider.address, ethers.parseEther("5"));

      await expect(bridge.checkWrappedInvariant(rogue.target))
        .to.emit(bridge, "InvariantViolation");
      expect(await bridge.paused()).to.equal(true);
    });
  });

  // =================================================================
  // Section 4 - access control and timelock
  // =================================================================

  describe("access control", () => {
    it("blocks non-admin from every configuration function", async () => {
      const { bridge, registry, native, outsider } = await loadFixture(deployFixture);
      await expect(bridge.connect(outsider).registerToken(outsider.address, 1)).to.be.reverted;
      await expect(bridge.connect(outsider).setSupportedChain(5n, true)).to.be.reverted;
      await expect(bridge.connect(outsider).setRateLimit(native.target, 1n)).to.be.reverted;
      await expect(bridge.connect(outsider).unpause()).to.be.reverted;
      await expect(bridge.connect(outsider).addGuardian(outsider.address)).to.be.reverted;
      await expect(registry.connect(outsider).addValidator(outsider.address)).to.be.reverted;
      await expect(registry.connect(outsider).setThreshold(3)).to.be.reverted;
    });

    it("keeps the validator threshold a strict majority", async () => {
      const { registry } = await loadFixture(deployFixture);
      await expect(registry.setThreshold(2)).to.be.revertedWith(
        "Registry: threshold not majority"
      ); // 2 of 5 is not a majority
      await expect(registry.setThreshold(6)).to.be.revertedWith("Registry: threshold > set");
    });

    it("refuses validator removal that would break quorum", async () => {
      const { registry, validators } = await loadFixture(deployFixture);
      // 5 validators, threshold 3: removing two is fine, a third would leave
      // 2 < threshold and must revert.
      await registry.removeValidator(validators[0].address);
      await registry.removeValidator(validators[1].address);
      await expect(
        registry.removeValidator(validators[2].address)
      ).to.be.revertedWith("Registry: would break quorum");
    });
  });

  describe("timelocked configuration", () => {
    it("enforces the delay on validator-set changes end to end", async () => {
      const { admin } = await loadFixture(deployFixture);
      const delay = 3600;

      const timelock = (await ethers.deployContract("TimelockController", [
        delay,
        [admin.address], // proposers
        [admin.address], // executors
        ethers.ZeroAddress, // no optional admin
      ])) as unknown as TimelockController;

      const validators = Array.from({ length: 3 }, () => ethers.Wallet.createRandom());
      const registry = (await ethers.deployContract("ValidatorRegistry", [
        timelock.target,
        validators.map((v) => v.address),
        2,
      ])) as unknown as ValidatorRegistry;

      // Direct call from the proposer EOA: rejected, only the timelock owns it.
      const newValidator = ethers.Wallet.createRandom().address;
      await expect(registry.addValidator(newValidator)).to.be.reverted;

      const call = registry.interface.encodeFunctionData("addValidator", [newValidator]);
      await timelock.schedule(
        registry.target, 0, call, ethers.ZeroHash, ethers.ZeroHash, delay
      );

      // Executing before the delay elapses: rejected.
      await expect(
        timelock.execute(registry.target, 0, call, ethers.ZeroHash, ethers.ZeroHash)
      ).to.be.reverted;

      await time.increase(delay + 1);
      await timelock.execute(registry.target, 0, call, ethers.ZeroHash, ethers.ZeroHash);
      expect(await registry.isValidator(newValidator)).to.equal(true);
    });
  });

  // =================================================================
  // Outbound path basics
  // =================================================================

  describe("lockTokens", () => {
    it("locks, credits, and emits the cross-chain notification", async () => {
      const { bridge, native, user, recipient } = await loadFixture(deployFixture);
      const amount = ethers.parseEther("25");
      await native.connect(user).approve(bridge.target, amount);
      await expect(
        bridge.connect(user).lockTokens(native.target, amount, REMOTE_CHAIN, recipient.address)
      )
        .to.emit(bridge, "TokensLocked")
        .withArgs(1n, native.target, user.address, recipient.address, amount, REMOTE_CHAIN);
      expect(await bridge.lockedBalance(native.target)).to.equal(amount);
    });

    it("rejects unregistered tokens, bad chains, and zero values", async () => {
      const { bridge, native, user, outsider } = await loadFixture(deployFixture);
      await expect(
        bridge.connect(user).lockTokens(outsider.address, 1n, REMOTE_CHAIN, user.address)
      ).to.be.revertedWith("Bridge: token not registered as native");
      await expect(
        bridge.connect(user).lockTokens(native.target, 1n, 31337n, user.address)
      ).to.be.revertedWith("Bridge: unsupported destination chain");
      await expect(
        bridge.connect(user).lockTokens(native.target, 0n, REMOTE_CHAIN, user.address)
      ).to.be.revertedWith("Bridge: zero amount");
      await expect(
        bridge.connect(user).lockTokens(native.target, 1n, REMOTE_CHAIN, ethers.ZeroAddress)
      ).to.be.revertedWith("Bridge: zero recipient");
    });
  });

  describe("burnWrapped", () => {
    it("requires allowance and sufficient minted supply", async () => {
      const { bridge, wrapped, user, makeMessage, sign } = await loadFixture(deployFixture);
      const m = makeMessage({
        action: ACTION_MINT,
        token: wrapped.target as string,
        recipient: user.address,
        amount: ethers.parseEther("10"),
      });
      await bridge.mintWrapped(m, await sign(m));

      // No allowance yet - burn must revert.
      await expect(
        bridge.connect(user).burnWrapped(wrapped.target, ethers.parseEther("5"), REMOTE_CHAIN, user.address)
      ).to.be.reverted;

      await wrapped.connect(user).approve(bridge.target, ethers.parseEther("100"));
      await expect(
        bridge.connect(user).burnWrapped(wrapped.target, ethers.parseEther("11"), REMOTE_CHAIN, user.address)
      ).to.be.revertedWith("Bridge: burn exceeds minted supply");

      await expect(
        bridge.connect(user).burnWrapped(wrapped.target, ethers.parseEther("10"), REMOTE_CHAIN, user.address)
      ).to.emit(bridge, "WrappedBurned");
    });
  });
});
