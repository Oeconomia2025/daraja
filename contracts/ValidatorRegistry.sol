// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title ValidatorRegistry
/// @notice Holds the approved validator set and enforces quorum verification
///         over EIP-712 digests.
///
/// Trust model: a message is final on the destination chain only when at
/// least `threshold` distinct current validators have signed its digest.
/// Forging a withdrawal therefore requires compromising `threshold` validator
/// keys. `threshold` is constrained to a strict majority of the set, so a
/// minority of compromised keys can never move funds.
///
/// The owner is intended to be a TimelockController. Every set or threshold
/// change must pass through that timelock, so the validator set cannot be
/// silently replaced: any change is publicly visible on-chain for the full
/// delay before it takes effect.
contract ValidatorRegistry is Ownable2Step {
    mapping(address => bool) public isValidator;
    uint256 public validatorCount;
    uint256 public threshold;

    event ValidatorAdded(address indexed validator);
    event ValidatorRemoved(address indexed validator);
    event ThresholdChanged(uint256 oldThreshold, uint256 newThreshold);

    /// @param timelock The TimelockController that owns this registry.
    /// @param initialValidators Initial signer set; no zeros, no duplicates.
    /// @param initialThreshold Signatures required; must be a strict majority.
    constructor(
        address timelock,
        address[] memory initialValidators,
        uint256 initialThreshold
    ) Ownable(timelock) {
        require(initialValidators.length > 0, "Registry: empty validator set");
        for (uint256 i = 0; i < initialValidators.length; i++) {
            address v = initialValidators[i];
            require(v != address(0), "Registry: zero validator");
            require(!isValidator[v], "Registry: duplicate validator");
            isValidator[v] = true;
            emit ValidatorAdded(v);
        }
        validatorCount = initialValidators.length;
        _setThreshold(initialThreshold);
    }

    // ---------------------------------------------------------------
    // Configuration (owner = timelock only)
    // ---------------------------------------------------------------

    function addValidator(address v) external onlyOwner {
        require(v != address(0), "Registry: zero validator");
        require(!isValidator[v], "Registry: already validator");
        isValidator[v] = true;
        validatorCount += 1;
        emit ValidatorAdded(v);
    }

    /// @dev Removal must not leave the set unable to reach quorum, and the
    ///      remaining threshold must still be a strict majority.
    function removeValidator(address v) external onlyOwner {
        require(isValidator[v], "Registry: not a validator");
        require(validatorCount - 1 >= threshold, "Registry: would break quorum");
        isValidator[v] = false;
        validatorCount -= 1;
        emit ValidatorRemoved(v);
    }

    function setThreshold(uint256 newThreshold) external onlyOwner {
        _setThreshold(newThreshold);
    }

    function _setThreshold(uint256 newThreshold) private {
        require(newThreshold >= 1, "Registry: zero threshold");
        require(newThreshold <= validatorCount, "Registry: threshold > set");
        require(newThreshold > validatorCount / 2, "Registry: threshold not majority");
        emit ThresholdChanged(threshold, newThreshold);
        threshold = newThreshold;
    }

    // ---------------------------------------------------------------
    // Quorum verification
    // ---------------------------------------------------------------

    /// @notice Verify that `signatures` constitutes a valid quorum over
    ///         `digest`. Reverts unless every requirement holds.
    ///
    /// Enforcement, in order:
    ///  1. At least `threshold` signatures are present.
    ///  2. Each signature must recover (strict ECDSA: OZ rejects malleable
    ///     s-values and bad v) - an unrecoverable signature reverts.
    ///  3. Recovered signers must be in STRICTLY ASCENDING address order.
    ///     A duplicated signer, in any position, breaks strict ordering and
    ///     reverts, so the same key can never be counted twice.
    ///  4. Every recovered signer must be a CURRENT member of the approved
    ///     set - a signature count alone is never sufficient.
    ///
    /// Every provided signature must be valid: a quorum bundle containing
    /// even one bad signature is rejected outright rather than filtered.
    function verifyQuorum(bytes32 digest, bytes[] calldata signatures) external view {
        require(signatures.length >= threshold, "Registry: insufficient signatures");
        address lastSigner = address(0);
        for (uint256 i = 0; i < signatures.length; i++) {
            address signer = ECDSA.recover(digest, signatures[i]);
            require(signer > lastSigner, "Registry: unsorted or duplicate signer");
            require(isValidator[signer], "Registry: signer not in validator set");
            lastSigner = signer;
        }
    }
}
