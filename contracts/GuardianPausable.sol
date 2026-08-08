// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title GuardianPausable
/// @notice Multi-party emergency pause. No single guardian key can halt the
///         bridge alone: `pauseQuorum` distinct guardians must vote within a
///         rolling window. Votes expire so a stale vote from a compromised
///         key months ago cannot combine with a fresh one.
///
/// Safety/liveness tradeoff: pausing is deliberately easier than unpausing.
/// A guardian quorum (fast, low bar) can halt the bridge; only the timelocked
/// admin (slow, high bar) can resume it. A malicious guardian quorum can
/// freeze funds temporarily (liveness loss) but can never move them.
abstract contract GuardianPausable is Pausable {
    uint256 public constant PAUSE_VOTE_WINDOW = 1 hours;

    mapping(address => bool) public isGuardian;
    uint256 public guardianCount;
    uint256 public pauseQuorum;

    uint256 public voteRound; // increments whenever a new voting round starts
    uint256 public roundStart;
    uint256 public roundVotes;
    mapping(uint256 => mapping(address => bool)) public hasVotedPause;

    event GuardianAdded(address indexed guardian);
    event GuardianRemoved(address indexed guardian);
    event PauseQuorumChanged(uint256 oldQuorum, uint256 newQuorum);
    event PauseVoted(address indexed guardian, uint256 indexed round, uint256 votes);

    modifier onlyGuardian() {
        require(isGuardian[msg.sender], "Guardian: caller is not a guardian");
        _;
    }

    /// @dev Called by the inheriting contract's constructor.
    function _initGuardians(address[] memory initialGuardians, uint256 quorum) internal {
        require(initialGuardians.length > 0, "Guardian: empty set");
        for (uint256 i = 0; i < initialGuardians.length; i++) {
            address g = initialGuardians[i];
            require(g != address(0), "Guardian: zero guardian");
            require(!isGuardian[g], "Guardian: duplicate guardian");
            isGuardian[g] = true;
            emit GuardianAdded(g);
        }
        guardianCount = initialGuardians.length;
        _setPauseQuorum(quorum);
    }

    function _setPauseQuorum(uint256 quorum) internal {
        require(quorum >= 2, "Guardian: quorum below 2");
        require(quorum <= guardianCount, "Guardian: quorum > guardian count");
        emit PauseQuorumChanged(pauseQuorum, quorum);
        pauseQuorum = quorum;
    }

    function _addGuardian(address g) internal {
        require(g != address(0), "Guardian: zero guardian");
        require(!isGuardian[g], "Guardian: already guardian");
        isGuardian[g] = true;
        guardianCount += 1;
        emit GuardianAdded(g);
    }

    function _removeGuardian(address g) internal {
        require(isGuardian[g], "Guardian: not a guardian");
        require(guardianCount - 1 >= pauseQuorum, "Guardian: would break pause quorum");
        isGuardian[g] = false;
        guardianCount -= 1;
        emit GuardianRemoved(g);
    }

    /// @notice Vote to pause the bridge. When `pauseQuorum` distinct
    ///         guardians vote within PAUSE_VOTE_WINDOW, the bridge pauses.
    function votePause() external onlyGuardian {
        if (block.timestamp > roundStart + PAUSE_VOTE_WINDOW) {
            // Previous round expired - start a fresh one.
            voteRound += 1;
            roundStart = block.timestamp;
            roundVotes = 0;
        }
        require(!hasVotedPause[voteRound][msg.sender], "Guardian: already voted this round");
        hasVotedPause[voteRound][msg.sender] = true;
        roundVotes += 1;
        emit PauseVoted(msg.sender, voteRound, roundVotes);
        if (roundVotes >= pauseQuorum && !paused()) {
            _pause();
        }
    }
}
