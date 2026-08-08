// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// The bridge's admin is a stock OpenZeppelin TimelockController; importing it
// here makes Hardhat compile the artifact for deployment and tests. Every
// configuration change (token registration, rate limits, validator-set and
// threshold changes, unpause) must be scheduled through this contract and is
// publicly visible for the full delay before it can execute.
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
