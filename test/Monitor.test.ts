import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import type { HDNodeWallet } from "ethers";
import type {
  BridgedToken,
  MockERC20,
  MockRuggableToken,
  Daraja,
  ValidatorRegistry,
} from "../typechain-types";
import { SourceEvent, buildMessage, selectQuorum, signMessage } from "../offchain/lib";
import { checkCrossChainPair, checkTokenInvariant } from "../offchain/monitorCore";

// Two bridges on the hardhat network stand in for the two sides of the
// bridge: bridgeA holds native tokens (source side), bridgeB mints wrapped
// (destination side). The monitor core only reads state, so this exercises
// exactly what the daemon does across two real chains.
const SOURCE_CHAIN = 97n;

describe("bridge monitor", () => {
  async function deployFixture() {
    const [admin, user, guardian1, guardian2] = await ethers.getSigners();

    const validators: HDNodeWallet[] = Array.from({ length: 3 }, () =>
      ethers.Wallet.createRandom()
    ).sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1));
    const threshold = 2;
    const validatorSet = new Set(validators.map((v) => v.address.toLowerCase()));

    async function deployBridge(): Promise<{ bridge: Daraja; registry: ValidatorRegistry }> {
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
      await bridge.setSupportedChain(SOURCE_CHAIN, true);
      return { bridge, registry };
    }

    const { bridge: bridgeA } = await deployBridge(); // native side
    const { bridge: bridgeB } = await deployBridge(); // wrapped side

    const native = (await ethers.deployContract("MockERC20", [
      "Native",
      "NAT",
    ])) as unknown as MockERC20;
    const wrapped = (await ethers.deployContract("BridgedToken", [
      "Wrapped", "wNAT", 18, bridgeB.target,
    ])) as unknown as BridgedToken;

    await bridgeA.registerToken(native.target, 1);
    await bridgeA.setRateLimit(native.target, ethers.parseEther("1000"));
    await bridgeB.registerToken(wrapped.target, 2);
    await bridgeB.setRateLimit(wrapped.target, ethers.parseEther("1000"));

    await native.mint(user.address, ethers.parseEther("1000"));

    const chainId = (await ethers.provider.getNetwork()).chainId;

    async function lockOnA(amount: bigint) {
      await native.connect(user).approve(bridgeA.target, amount);
      await bridgeA.connect(user).lockTokens(native.target, amount, SOURCE_CHAIN, user.address);
    }

    let nonce = 0n;
    async function mintOnB(amount: bigint) {
      nonce += 1n;
      const ev: SourceEvent = {
        kind: "TokensLocked",
        sourceChainId: SOURCE_CHAIN,
        nonce,
        token: native.target as string,
        recipient: user.address,
        amount,
        destChainId: chainId,
        txHash: ethers.ZeroHash,
        logIndex: 0,
      };
      const message = buildMessage(ev, bridgeB.target as string, wrapped.target as string);
      const sigs = await Promise.all(validators.map((v) => signMessage(v, message)));
      await bridgeB.mintWrapped(message, selectQuorum(message, sigs, validatorSet, threshold));
    }

    return { admin, user, bridgeA, bridgeB, native, wrapped, lockOnA, mintOnB };
  }

  describe("local invariants (monitorCore.checkTokenInvariant)", () => {
    it("reports a healthy native token as sound", async () => {
      const { bridgeA, native, lockOnA } = await loadFixture(deployFixture);
      await lockOnA(ethers.parseEther("100"));
      const status = await checkTokenInvariant(
        ethers.provider, bridgeA.target as string, native.target as string
      );
      expect(status.kind).to.equal("Native");
      expect(status.violated).to.equal(false);
      expect(status.actual).to.equal(status.expected);
    });

    it("detects drained native backing", async () => {
      const { admin, user, bridgeA } = await loadFixture(deployFixture);
      const rug = (await ethers.deployContract(
        "MockRuggableToken"
      )) as unknown as MockRuggableToken;
      await bridgeA.registerToken(rug.target, 1);
      await bridgeA.setRateLimit(rug.target, ethers.parseEther("1000"));
      await rug.mint(user.address, ethers.parseEther("100"));
      await rug.connect(user).approve(bridgeA.target, ethers.parseEther("100"));
      await bridgeA.connect(user).lockTokens(rug.target, ethers.parseEther("100"), SOURCE_CHAIN, user.address);

      await rug.destroy(bridgeA.target, ethers.parseEther("30"));

      const status = await checkTokenInvariant(
        ethers.provider, bridgeA.target as string, rug.target as string
      );
      expect(status.violated).to.equal(true);
      expect(status.expected).to.equal(ethers.parseEther("100"));
      expect(status.actual).to.equal(ethers.parseEther("70"));
    });

    it("treats user-initiated wrapped burns as harmless but flags rogue mints", async () => {
      const { user, bridgeB, wrapped, mintOnB } = await loadFixture(deployFixture);
      await mintOnB(ethers.parseEther("50"));

      // Direct burn shrinks supply below mintedSupply: NOT a violation.
      await wrapped.connect(user).burn(ethers.parseEther("10"));
      let status = await checkTokenInvariant(
        ethers.provider, bridgeB.target as string, wrapped.target as string
      );
      expect(status.kind).to.equal("Wrapped");
      expect(status.violated).to.equal(false);

      // A wrapped token whose minter is not the bridge: excess supply IS one.
      const [, , , outsider] = await ethers.getSigners();
      const rogue = (await ethers.deployContract("BridgedToken", [
        "Rogue", "RGE", 18, outsider.address,
      ])) as unknown as BridgedToken;
      await bridgeB.registerToken(rogue.target, 2);
      await rogue.connect(outsider).mint(outsider.address, ethers.parseEther("1"));
      status = await checkTokenInvariant(
        ethers.provider, bridgeB.target as string, rogue.target as string
      );
      expect(status.violated).to.equal(true);
    });

    it("reports unregistered tokens as None without violation", async () => {
      const { bridgeA } = await loadFixture(deployFixture);
      const status = await checkTokenInvariant(
        ethers.provider,
        bridgeA.target as string,
        ethers.Wallet.createRandom().address
      );
      expect(status.kind).to.equal("None");
      expect(status.violated).to.equal(false);
    });
  });

  describe("cross-chain supply invariant (monitorCore.checkCrossChainPair)", () => {
    it("is sound while minted stays within locked", async () => {
      const { bridgeA, bridgeB, native, wrapped, lockOnA, mintOnB } =
        await loadFixture(deployFixture);
      await lockOnA(ethers.parseEther("100"));
      await mintOnB(ethers.parseEther("90"));

      const status = await checkCrossChainPair(
        ethers.provider, bridgeA.target as string, native.target as string,
        ethers.provider, bridgeB.target as string, wrapped.target as string
      );
      expect(status).to.not.be.null;
      expect(status!.locked).to.equal(ethers.parseEther("100"));
      expect(status!.minted).to.equal(ethers.parseEther("90"));
      expect(status!.violated).to.equal(false);
    });

    it("flags minted exceeding locked - the gap no contract can see", async () => {
      const { bridgeA, bridgeB, native, wrapped, lockOnA, mintOnB } =
        await loadFixture(deployFixture);
      await lockOnA(ethers.parseEther("100"));
      // A validator-quorum compromise mints beyond the locked backing. Both
      // chains individually accept this; only the pair view exposes it.
      await mintOnB(ethers.parseEther("90"));
      await mintOnB(ethers.parseEther("30"));

      const status = await checkCrossChainPair(
        ethers.provider, bridgeA.target as string, native.target as string,
        ethers.provider, bridgeB.target as string, wrapped.target as string
      );
      expect(status!.minted).to.equal(ethers.parseEther("120"));
      expect(status!.violated).to.equal(true);
    });

    it("skips reverse-direction mapping entries", async () => {
      const { bridgeA, bridgeB, native, wrapped } = await loadFixture(deployFixture);
      // Wrapped-side token passed as the source: not a native->wrapped pair.
      const status = await checkCrossChainPair(
        ethers.provider, bridgeB.target as string, wrapped.target as string,
        ethers.provider, bridgeA.target as string, native.target as string
      );
      expect(status).to.be.null;
    });
  });

  describe("guardian response path", () => {
    it("on-chain check pauses the bridge once the monitor detects a drain", async () => {
      const { user, bridgeA } = await loadFixture(deployFixture);
      const rug = (await ethers.deployContract(
        "MockRuggableToken"
      )) as unknown as MockRuggableToken;
      await bridgeA.registerToken(rug.target, 1);
      await bridgeA.setRateLimit(rug.target, ethers.parseEther("1000"));
      await rug.mint(user.address, ethers.parseEther("100"));
      await rug.connect(user).approve(bridgeA.target, ethers.parseEther("100"));
      await bridgeA.connect(user).lockTokens(rug.target, ethers.parseEther("100"), SOURCE_CHAIN, user.address);
      await rug.destroy(bridgeA.target, ethers.parseEther("1"));

      // The daemon's exact sequence: free off-chain read, then the
      // permissionless on-chain check that pauses in the same transaction.
      const status = await checkTokenInvariant(
        ethers.provider, bridgeA.target as string, rug.target as string
      );
      expect(status.violated).to.equal(true);
      await bridgeA.checkNativeInvariant(rug.target);
      expect(await bridgeA.paused()).to.equal(true);
    });
  });
});
