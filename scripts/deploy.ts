import { ethers } from "hardhat";

/**
 * Deploys the full bridge stack on one chain:
 *   TimelockController -> ValidatorRegistry -> Daraja
 *
 * Env configuration (.env):
 *   TIMELOCK_DELAY   seconds (default 3600; use 86400+ in production)
 *   VALIDATORS       comma-separated addresses (default: deployer only - TESTNET ONLY)
 *   THRESHOLD        quorum size (default: strict majority of VALIDATORS)
 *   GUARDIANS        comma-separated addresses (default: deployer x2 padding is NOT
 *                    allowed - supply at least 2 distinct addresses, or the
 *                    deployer plus GUARDIAN2)
 *   GUARDIAN_QUORUM  votes to pause (default 2)
 *
 * After deployment, every configuration call (registerToken, setRateLimit,
 * setSupportedChain, validator changes, unpause) must be scheduled through
 * the timelock. Nothing is configured directly.
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const delay = parseInt(process.env.TIMELOCK_DELAY || "3600", 10);

  const validators = (process.env.VALIDATORS || deployer.address)
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);
  const threshold = parseInt(
    process.env.THRESHOLD || String(Math.floor(validators.length / 2) + 1),
    10
  );

  const guardians = (process.env.GUARDIANS || "")
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);
  const guardianQuorum = parseInt(process.env.GUARDIAN_QUORUM || "2", 10);
  if (guardians.length < 2) {
    throw new Error(
      "Supply at least 2 distinct GUARDIANS in .env - the pause council is multi-party by design"
    );
  }

  if (validators.length === 1) {
    console.warn(
      "WARNING: single-validator set. Acceptable for a first testnet deployment only."
    );
  }

  console.log(`Timelock delay: ${delay}s`);
  console.log(`Validators (${validators.length}, threshold ${threshold}):`, validators);
  console.log(`Guardians (${guardians.length}, quorum ${guardianQuorum}):`, guardians);

  // Deployer is proposer+executor on testnet; hand these roles to a Safe for
  // production and renounce.
  const timelock = await ethers.deployContract("TimelockController", [
    delay,
    [deployer.address],
    [deployer.address],
    ethers.ZeroAddress,
  ]);
  await timelock.waitForDeployment();
  console.log("TimelockController:", timelock.target);

  const registry = await ethers.deployContract("ValidatorRegistry", [
    timelock.target,
    validators,
    threshold,
  ]);
  await registry.waitForDeployment();
  console.log("ValidatorRegistry:", registry.target);

  const bridge = await ethers.deployContract("Daraja", [
    timelock.target,
    registry.target,
    guardians,
    guardianQuorum,
  ]);
  await bridge.waitForDeployment();
  console.log("Daraja:", bridge.target);

  console.log("\nNext steps (all via timelock schedule/execute):");
  console.log("  1. registerToken(token, 1=Native | 2=Wrapped)");
  console.log("  2. setRateLimit(token, maxPerWindow)  <- outflow is blocked until set");
  console.log("  3. setSupportedChain(remoteChainId, true)");
  console.log("  4. setLargeOutflowThreshold(token, threshold)");
  console.log("  5. Deploy BridgedToken(name, symbol, decimals, bridge) on the destination chain");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
