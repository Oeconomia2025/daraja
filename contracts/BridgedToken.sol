// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";

/// @title BridgedToken
/// @notice Wrapped representation of a token locked on another chain.
/// @dev The ONLY address able to mint is the bridge, fixed immutably at
///      deployment. There is no owner, no upgrade path, and no other
///      privileged function, so wrapped supply can change only through the
///      bridge's quorum-verified mint path and user-initiated burns.
contract BridgedToken is ERC20, ERC20Burnable {
    address public immutable bridge;
    uint8 private immutable _decimals;

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        address bridge_
    ) ERC20(name_, symbol_) {
        require(bridge_ != address(0), "BridgedToken: zero bridge");
        bridge = bridge_;
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    /// @notice Mint wrapped tokens. Bridge only.
    function mint(address to, uint256 amount) external {
        require(msg.sender == bridge, "BridgedToken: caller is not the bridge");
        _mint(to, amount);
    }
}
