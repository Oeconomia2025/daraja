// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Plain mintable ERC20 for tests.
contract MockERC20 is ERC20 {
    constructor(string memory n, string memory s) ERC20(n, s) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Token whose balances can be destroyed by anyone. Used ONLY in tests
///      to simulate the bridge's backing being drained, so the permissionless
///      invariant check and auto-pause can be exercised.
contract MockRuggableToken is ERC20 {
    constructor() ERC20("Ruggable", "RUG") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function destroy(address from, uint256 amount) external {
        _burn(from, amount);
    }
}

/// @dev Fee-on-transfer token: burns 1% on every transfer. Used to prove the
///      bridge credits only the amount actually received.
contract MockFeeToken is ERC20 {
    constructor() ERC20("Fee Token", "FEE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = value / 100;
            super._update(from, address(0), fee); // burn the fee
            super._update(from, to, value - fee);
        } else {
            super._update(from, to, value);
        }
    }
}
