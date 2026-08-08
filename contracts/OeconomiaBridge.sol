// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {BridgeMessages} from "./BridgeMessages.sol";
import {ValidatorRegistry} from "./ValidatorRegistry.sol";
import {BridgedToken} from "./BridgedToken.sol";
import {GuardianPausable} from "./GuardianPausable.sol";

/// @title OeconomiaBridge
/// @notice Lock-and-mint cross-chain bridge. The same contract is deployed on
///         every chain; each token is registered as either Native (locked and
///         released here) or Wrapped (minted and burned here).
///
/// TRUST MODEL
/// The destination chain is convinced an event happened on the source chain
/// by an EIP-712 quorum of an off-chain validator set held in an immutable
/// ValidatorRegistry. Forging a withdrawal requires compromising a strict
/// majority (`registry.threshold`) of validator keys. There is no optimistic
/// window and no on-chain proof verification in this build; that limitation
/// is documented and the blast-radius controls (rate limits, guardian pause,
/// invariant auto-pause) exist to bound the damage of a validator compromise.
///
/// ROLE SEGREGATION
///  - Timelocked admin (DEFAULT_ADMIN_ROLE): configuration only. It cannot
///    mint, release, or move funds - every fund movement requires a validator
///    quorum it does not control.
///  - Guardians: pause only (multi-party, see GuardianPausable). Cannot move
///    funds or change configuration.
///  - Validators: sign messages off-chain. Hold no on-chain call rights.
///  - Relayers: fully permissionless - anyone may submit a validly signed
///    message; submission grants no authority beyond what the quorum signed.
/// No single role can both change configuration and move funds.
contract OeconomiaBridge is AccessControl, ReentrancyGuard, GuardianPausable, EIP712 {
    using SafeERC20 for IERC20;
    using BridgeMessages for BridgeMessages.BridgeMessage;

    enum TokenType {
        None,
        Native,
        Wrapped
    }

    struct RateLimit {
        uint256 maxPerWindow; // 0 = unconfigured; outflow is BLOCKED (fail closed)
        uint256 windowStart;
        uint256 spent;
    }

    uint256 public constant RATE_WINDOW = 6 hours;

    ValidatorRegistry public immutable registry;

    mapping(address => TokenType) public tokenType;
    mapping(uint256 => bool) public supportedChains;
    /// @dev Replay protection: EIP-712 digest of every executed message.
    mapping(bytes32 => bool) public processedMessages;
    /// @dev Native tokens actually received and still owed to remote chains.
    mapping(address => uint256) public lockedBalance;
    /// @dev Wrapped tokens minted by this bridge, net of bridge-side burns.
    mapping(address => uint256) public mintedSupply;
    mapping(address => RateLimit) public rateLimits;
    /// @dev Outflows >= this amount emit LargeOutflow for off-chain alerting.
    mapping(address => uint256) public largeOutflowThreshold;

    uint256 public outboundNonce;

    // ------------------------------------------------------------------
    // Events (monitoring hooks - every privileged call and fund movement)
    // ------------------------------------------------------------------
    event TokensLocked(
        uint256 indexed nonce,
        address indexed token,
        address indexed sender,
        address recipient,
        uint256 amountReceived,
        uint256 destChainId
    );
    event TokensReleased(bytes32 indexed digest, address indexed token, address indexed recipient, uint256 amount);
    event WrappedMinted(bytes32 indexed digest, address indexed token, address indexed recipient, uint256 amount);
    event WrappedBurned(
        uint256 indexed nonce,
        address indexed token,
        address indexed sender,
        address recipient,
        uint256 amount,
        uint256 destChainId
    );
    event LargeOutflow(address indexed token, address indexed recipient, uint256 amount);
    event InvariantViolation(address indexed token, uint256 expected, uint256 actual);
    event TokenRegistered(address indexed token, TokenType tokenType);
    event ChainSupportSet(uint256 indexed chainId, bool supported);
    event RateLimitSet(address indexed token, uint256 maxPerWindow);
    event LargeOutflowThresholdSet(address indexed token, uint256 threshold);
    event Unpaused_(address indexed admin);

    /// @param timelock TimelockController; sole holder of DEFAULT_ADMIN_ROLE.
    /// @param registry_ Immutable validator registry (its own owner is the timelock).
    /// @param guardians Multi-party pause council.
    /// @param guardianQuorum Distinct guardian votes required to pause (>= 2).
    constructor(
        address timelock,
        ValidatorRegistry registry_,
        address[] memory guardians,
        uint256 guardianQuorum
    ) EIP712("OeconomiaBridge", "1") {
        require(timelock != address(0), "Bridge: zero timelock");
        require(address(registry_) != address(0), "Bridge: zero registry");
        // Initialization audit (spec 4): the registry constructor has already
        // rejected an empty validator set and a non-majority threshold, so no
        // zero-value signer configuration can reach this point.
        require(registry_.validatorCount() > 0, "Bridge: uninitialized registry");
        registry = registry_;
        _grantRole(DEFAULT_ADMIN_ROLE, timelock);
        _initGuardians(guardians, guardianQuorum);
    }

    // ==================================================================
    // OUTBOUND: this chain -> remote chain
    // ==================================================================

    /// @notice Lock native tokens to be minted as wrapped on `destChainId`.
    /// @dev Ordering note (spec 3): the token transfer is the only external
    ///      interaction and it must precede the effects because the amount
    ///      actually received (fee-on-transfer safe) is measured by
    ///      before/after balance comparison. Re-entry during the token call
    ///      is blocked by nonReentrant, and only timelock-vetted tokens are
    ///      registered. All state (lockedBalance, nonce) fully settles before
    ///      the TokensLocked event - the cross-chain notification - is emitted.
    function lockTokens(
        address token,
        uint256 amount,
        uint256 destChainId,
        address recipient
    ) external nonReentrant whenNotPaused {
        require(tokenType[token] == TokenType.Native, "Bridge: token not registered as native");
        require(supportedChains[destChainId], "Bridge: unsupported destination chain");
        require(destChainId != block.chainid, "Bridge: destination is this chain");
        require(recipient != address(0), "Bridge: zero recipient");
        require(amount > 0, "Bridge: zero amount");

        uint256 balanceBefore = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - balanceBefore;
        require(received > 0, "Bridge: nothing received");

        lockedBalance[token] += received;
        uint256 nonce = ++outboundNonce;

        emit TokensLocked(nonce, token, msg.sender, recipient, received, destChainId);
    }

    /// @notice Burn wrapped tokens to release the native tokens on `destChainId`.
    /// @dev Effects (mintedSupply, nonce) settle before the burnFrom
    ///      interaction; the burn call targets a bridge-deployed BridgedToken
    ///      registered by the timelock, and nonReentrant guards the path.
    function burnWrapped(
        address token,
        uint256 amount,
        uint256 destChainId,
        address recipient
    ) external nonReentrant whenNotPaused {
        require(tokenType[token] == TokenType.Wrapped, "Bridge: token not registered as wrapped");
        require(supportedChains[destChainId], "Bridge: unsupported destination chain");
        require(destChainId != block.chainid, "Bridge: destination is this chain");
        require(recipient != address(0), "Bridge: zero recipient");
        require(amount > 0, "Bridge: zero amount");
        require(mintedSupply[token] >= amount, "Bridge: burn exceeds minted supply");

        mintedSupply[token] -= amount;
        uint256 nonce = ++outboundNonce;

        BridgedToken(token).burnFrom(msg.sender, amount);

        emit WrappedBurned(nonce, token, msg.sender, recipient, amount, destChainId);
    }

    // ==================================================================
    // INBOUND: remote chain -> this chain (quorum-verified)
    // ==================================================================

    /// @notice Release native tokens against a quorum-signed message.
    ///
    /// Every enforcement gate, in execution order (spec 2 and 3):
    ///  1. whenNotPaused - halted bridge parses nothing.
    ///  2. Strict field validation (BridgeMessages.validate) - wrong chain,
    ///     wrong bridge address, zero fields, wrong action all revert.
    ///  3. Source chain must be an approved counterparty.
    ///  4. Token must be registered Native on this chain.
    ///  5. Replay check on the EIP-712 digest BEFORE any funds move.
    ///  6. Validator quorum verification (distinct, current, >= threshold).
    ///  7. Supply invariant: amount must not exceed lockedBalance; checked
    ///     arithmetic makes over-release revert on-chain, not just in tests.
    ///  8. Outflow rate limit (fail-closed if unconfigured).
    ///  9. Effects (processed flag, balance decrement, rate-limit spend) all
    ///     settle, then the token transfer runs LAST.
    function releaseTokens(
        BridgeMessages.BridgeMessage calldata m,
        bytes[] calldata signatures
    ) external nonReentrant whenNotPaused {
        m.validate(BridgeMessages.ACTION_RELEASE, address(this));
        require(supportedChains[m.sourceChainId], "Bridge: unsupported source chain");
        require(tokenType[m.token] == TokenType.Native, "Bridge: token not registered as native");

        bytes32 digest = _hashTypedDataV4(m.structHash());
        require(!processedMessages[digest], "Bridge: message already processed");
        registry.verifyQuorum(digest, signatures);

        require(m.amount <= lockedBalance[m.token], "Bridge: release exceeds locked balance");

        processedMessages[digest] = true;
        lockedBalance[m.token] -= m.amount;
        _consumeRateLimit(m.token, m.amount);
        _flagLargeOutflow(m.token, m.recipient, m.amount);

        IERC20(m.token).safeTransfer(m.recipient, m.amount);

        emit TokensReleased(digest, m.token, m.recipient, m.amount);
    }

    /// @notice Mint wrapped tokens against a quorum-signed message.
    /// @dev Same gate ordering as releaseTokens. The cross-chain supply
    ///      invariant (wrapped minted <= native locked on the source) cannot
    ///      be read on-chain from here; its enforceable local projection is
    ///      that supply changes ONLY via quorum-verified mints, bounded by
    ///      the rate limit, and that totalSupply can never exceed
    ///      mintedSupply (checkWrappedInvariant pauses if it does).
    function mintWrapped(
        BridgeMessages.BridgeMessage calldata m,
        bytes[] calldata signatures
    ) external nonReentrant whenNotPaused {
        m.validate(BridgeMessages.ACTION_MINT, address(this));
        require(supportedChains[m.sourceChainId], "Bridge: unsupported source chain");
        require(tokenType[m.token] == TokenType.Wrapped, "Bridge: token not registered as wrapped");

        bytes32 digest = _hashTypedDataV4(m.structHash());
        require(!processedMessages[digest], "Bridge: message already processed");
        registry.verifyQuorum(digest, signatures);

        processedMessages[digest] = true;
        mintedSupply[m.token] += m.amount;
        _consumeRateLimit(m.token, m.amount);
        _flagLargeOutflow(m.token, m.recipient, m.amount);

        BridgedToken(m.token).mint(m.recipient, m.amount);

        emit WrappedMinted(digest, m.token, m.recipient, m.amount);
    }

    // ==================================================================
    // INVARIANT MONITORING (permissionless - spec 5)
    // ==================================================================

    /// @notice Anyone may check a native token's backing. If the bridge holds
    ///         less than it owes, the bridge pauses itself immediately.
    function checkNativeInvariant(address token) external {
        require(tokenType[token] == TokenType.Native, "Bridge: not a native token");
        uint256 actual = IERC20(token).balanceOf(address(this));
        uint256 expected = lockedBalance[token];
        if (actual < expected) {
            emit InvariantViolation(token, expected, actual);
            if (!paused()) _pause();
        }
    }

    /// @notice Anyone may check a wrapped token's supply. If more exists than
    ///         this bridge minted, minting happened outside the quorum path -
    ///         pause immediately.
    function checkWrappedInvariant(address token) external {
        require(tokenType[token] == TokenType.Wrapped, "Bridge: not a wrapped token");
        uint256 actual = IERC20(token).totalSupply();
        uint256 expected = mintedSupply[token];
        if (actual > expected) {
            emit InvariantViolation(token, expected, actual);
            if (!paused()) _pause();
        }
    }

    // ==================================================================
    // CONFIGURATION (timelock only - every call is delayed and public)
    // ==================================================================

    function registerToken(address token, TokenType t) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(token != address(0), "Bridge: zero token");
        require(t != TokenType.None, "Bridge: cannot register as None");
        require(tokenType[token] == TokenType.None, "Bridge: token already registered");
        tokenType[token] = t;
        emit TokenRegistered(token, t);
    }

    function setSupportedChain(uint256 chainId, bool supported) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(chainId != 0 && chainId != block.chainid, "Bridge: invalid chain id");
        supportedChains[chainId] = supported;
        emit ChainSupportSet(chainId, supported);
    }

    function setRateLimit(address token, uint256 maxPerWindow) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(tokenType[token] != TokenType.None, "Bridge: token not registered");
        rateLimits[token].maxPerWindow = maxPerWindow;
        emit RateLimitSet(token, maxPerWindow);
    }

    function setLargeOutflowThreshold(address token, uint256 threshold) external onlyRole(DEFAULT_ADMIN_ROLE) {
        largeOutflowThreshold[token] = threshold;
        emit LargeOutflowThresholdSet(token, threshold);
    }

    /// @notice Resuming after a pause requires the full timelock path.
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
        emit Unpaused_(msg.sender);
    }

    function addGuardian(address g) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _addGuardian(g);
    }

    function removeGuardian(address g) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _removeGuardian(g);
    }

    function setPauseQuorum(uint256 quorum) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setPauseQuorum(quorum);
    }

    // ==================================================================
    // INTERNALS
    // ==================================================================

    /// @dev Outflow rate limiter (spec 5). Fixed window; FAIL CLOSED: a token
    ///      with no configured limit cannot flow out at all. When the cap is
    ///      reached the transaction reverts - the message stays unprocessed
    ///      and can be resubmitted by anyone in a later window (safety chosen
    ///      over liveness; a stalled message delays, never loses, funds).
    function _consumeRateLimit(address token, uint256 amount) internal {
        RateLimit storage rl = rateLimits[token];
        require(rl.maxPerWindow > 0, "Bridge: rate limit not configured");
        if (block.timestamp >= rl.windowStart + RATE_WINDOW) {
            rl.windowStart = block.timestamp;
            rl.spent = 0;
        }
        require(rl.spent + amount <= rl.maxPerWindow, "Bridge: rate limit exceeded");
        rl.spent += amount;
    }

    function _flagLargeOutflow(address token, address recipient, uint256 amount) internal {
        uint256 threshold = largeOutflowThreshold[token];
        if (threshold > 0 && amount >= threshold) {
            emit LargeOutflow(token, recipient, amount);
        }
    }
}
