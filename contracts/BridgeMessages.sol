// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title BridgeMessages
/// @notice Canonical cross-chain message format and strict field validation.
/// @dev Messages arrive as ABI-typed calldata structs, so the Solidity ABI
///      decoder already enforces length and type integrity on the raw byte
///      stream: a truncated, oversized, or type-mismatched payload reverts in
///      the decoder before any bridge code runs. The checks in `validate`
///      then reject payloads that are well-formed bytes but semantically
///      hostile (wrong chain, wrong target contract, zero addresses, unknown
///      action). Signatures are checked over the EIP-712 digest of this exact
///      struct, so no field can be altered after signing.
library BridgeMessages {
    /// Release native tokens previously locked on this chain.
    uint8 internal constant ACTION_RELEASE = 1;
    /// Mint wrapped tokens backed by a lock on the source chain.
    uint8 internal constant ACTION_MINT = 2;

    struct BridgeMessage {
        uint8 action; // ACTION_RELEASE or ACTION_MINT
        uint256 sourceChainId; // chain where the deposit or burn happened
        uint256 destChainId; // must equal block.chainid of the executing chain
        address bridge; // must equal the executing bridge contract
        address token; // token address on the destination chain
        address recipient;
        uint256 amount;
        uint256 nonce; // unique per source-chain outbound event
    }

    bytes32 internal constant MESSAGE_TYPEHASH =
        keccak256(
            "BridgeMessage(uint8 action,uint256 sourceChainId,uint256 destChainId,address bridge,address token,address recipient,uint256 amount,uint256 nonce)"
        );

    /// @notice EIP-712 struct hash of a message.
    function structHash(BridgeMessage calldata m) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    MESSAGE_TYPEHASH,
                    m.action,
                    m.sourceChainId,
                    m.destChainId,
                    m.bridge,
                    m.token,
                    m.recipient,
                    m.amount,
                    m.nonce
                )
            );
    }

    /// @notice Reject any message whose fields are not exactly what this
    ///         chain and this bridge expect. Reverts on the first violation.
    /// @param m The decoded message.
    /// @param expectedAction The only action this code path may execute.
    /// @param self The executing bridge contract address.
    function validate(BridgeMessage calldata m, uint8 expectedAction, address self) internal view {
        require(m.action == expectedAction, "BridgeMessages: wrong action");
        require(m.destChainId == block.chainid, "BridgeMessages: wrong destination chain");
        require(m.bridge == self, "BridgeMessages: wrong bridge address");
        require(m.sourceChainId != block.chainid, "BridgeMessages: source is this chain");
        require(m.token != address(0), "BridgeMessages: zero token");
        require(m.recipient != address(0), "BridgeMessages: zero recipient");
        require(m.amount > 0, "BridgeMessages: zero amount");
    }
}
