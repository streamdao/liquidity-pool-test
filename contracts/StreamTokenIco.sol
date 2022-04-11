// SPDX-License-Identifier: MIT
pragma solidity >=0.8.9;

import "hardhat/console.sol";

import {StreamToken} from "./StreamToken.sol";

/**
 * @title StreamTokenIco
 * @author StreamDAO [contact@streamdao.org]
 * @notice Manages the ICO for StreanDAOs Stream Token (STRM)
 */
contract StreamTokenIco {
    /* ICO Phases
     * SEED
     * - Open to whitelisted investors only.
     * - Total contribution limit of 15,000 ETH
     * - Individual contribution limit of 1,500 ETH
     * GENERAL
     * - Open to everyone
     * - Total contribution limit of 30,000 ETH
     * - Individual contribution limit of 1,000 ETH
     * OPEN
     * - Open to everyone
     * - Total contribution limit of 100,000 ETH
     * - No individual contribution limit
     */
    enum Phase {
        SEED,
        GENERAL,
        OPEN
    }

    /// A structure which packs into a single slot whether a contributor exists, and their contribution.
    struct Contributor {
        /// Whether an address is registered as a contributor, independent of contributions.
        /// @dev Useful for implementing the whitelist feature.
        bool exists;
        /// Total contributions made by a contributor
        /// @dev Max contribution is 100000 ETH, which fits into 78 bits
        uint80 contributions;
        /// Total STRM tokens claimed
        /// @dev Max claimed is 500000 ETH, which fits into 80 bits
        uint80 claimedstrm;
    }

    // 1 ETH purchases 5 STRM
    uint8 private constant STRM_PER_ETH = 5;

    // Cummulative total contribution limits at each phase
    /// @dev uint80 allows packing all 3 into one slot. Max value requires 78 bits.
    uint80 private constant SEED_TOTAL = 15000 ether;
    uint80 private constant GENERAL_TOTAL = 30000 ether;

    // Individual contribution limits within each phase
    uint80 private constant SEED_INDIVIDUAL = 1500 ether;
    uint80 private constant GENERAL_INDIVIDUAL = 1000 ether;

    /* ==
     * == Begin packed slot
     * ==
     */

    /// The current phase of the StreamDAO ICO
    Phase public phase;

    /// Set accordingly to SEED_TOTAL|GENERAL_TOTAL|OPEN_TOTAL
    uint80 private phaseLimit;
    /// Set accordingly to SEED_INDIVIDUAL|GENERAL_INDIVIDUAL|GENERAL_TOTAL
    /// @dev Using GENERAL_TOTAL as a proxy for there being no individual contribution limit.
    uint80 private individualLimit;
    /// Total ETH contributions made
    uint80 public totalContributions;

    /// When paused, purchasing Stream Token "STRM" is not possible
    bool public paused = false;

    /* ==
     * == Begin packed slot
     * ==
     */

    // The StreamDAOs Stream token contract
    StreamToken public token;

    /// ETH available for withdrawing and/or Stream liquidity pool funding
    uint80 public availableFunds;

    /* ==
     * == End packed slots
     * ==
     */

    // Smart Contract deployer/owner
    address private immutable owner;
    // Stream Treasury: controls taxation and receives all StreamDAOs ICO/Tax funds
    address private immutable treasury;
    // Track contributors and contributions
    mapping(address => Contributor) private contributors;
    // Allow iteration on the above contributors mapping, used for Stream token distribution
    address[] private contributorKeys;

    /// Notifies when smart contract paused state changes
    /// @param isPaused Whether purchasing is present paused
    event IsPaused(bool isPaused);

    /// Notifies when a new Token Sale / ICO phase starts
    /// @param phase Seed|General|Open
    /// @param totalLimit Total ETH contribution cap. Inclusive of prior phases.
    /// @param individualLimit Individual ETH contribution cap. Inclusive of prior phases
    event PhaseStarted(string phase, uint80 totalLimit, uint80 individualLimit);

    /// Notifies when Stream Token "STRM" is purchased
    /// @param purchasedBy purchaser
    /// @param amount ETH spent
    event strmPurchased(address indexed purchasedBy, uint80 amount);

    /// Notifies when StreamDAOs ICO funds are withdrawn to treasury
    /// @param amount ETH withdrawn
    event WithdrawToTreasury(uint80 amount);

    /// Constructor
    /// @param _treasury Account which controls Stream token taxing, and receives tax funds
    /// @param _whitelist Whitelisted Seed phase investors
    constructor(address _treasury, address[] memory _whitelist) {
        owner = msg.sender;
        treasury = _treasury;
        token = new StreamToken(_treasury);

        // Set initial SEED phase state
        phase = Phase.SEED;
        phaseLimit = SEED_TOTAL;
        individualLimit = SEED_INDIVIDUAL;
        emit PhaseStarted("Seed", SEED_TOTAL, SEED_INDIVIDUAL);

        // Register whitelist as contributors, allowing them to contribute during Seed phase
        for (uint256 i = 0; i < _whitelist.length; i++) {
            _addContributor(_whitelist[i]);
        }
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "NOT_OWNER");
        _;
    }

    // Register all contributors
    function _addContributor(address _contributor) private {
        contributors[_contributor] = Contributor({
            exists: true,
            contributions: 0,
            claimedstrm: 0
        });
        contributorKeys.push(_contributor);
    }

    // 1 ETH converts to 5 STRM
    // solhint-disable-next-line
    function _ETHtostrm(uint80 value) private pure returns (uint256) {
        // We know - based on contract limits - this cannot overflow.
        // Max value is 100000 ETH * 5, which fills 80 bits
        unchecked {
            return uint256(value * STRM_PER_ETH);
        }
    }

    /// Return the number of Stream Tokens purchased through this ICO
    /// @param _by Purchaser
    /// @dev This is different from token.balanceOf(). Use that for current balance of Stream tokens "STRM", including transfers
    function tokensPurchased(address _by) external view returns (uint256) {
        return _ETHtostrm(contributors[_by].contributions);
    }

    /// Purchase Stream Tokens "STRM" : 1 ETH will purchase 5 STRM. Tokens are not released until Open phase.
    function buystrm() external payable {
        require(!paused, "PAUSED");
        require(
            phase != Phase.SEED || contributors[msg.sender].exists,
            "NOT_WHITELISTED"
        );
        require(msg.value > 0, "INVALID_AMOUNT");

        // pre-cast to uint80 for later use
        uint80 value = uint80(msg.value);
        // Check if total contributions would be exceeded, which is also true when value exceeds uint80 max
        require(
            msg.value == uint256(value) &&
                totalContributions + value <= phaseLimit,
            "TOTAL_CONTRIBUTION_EXCEEDED"
        );
        require(
            contributors[msg.sender].contributions + value <= individualLimit,
            "INDIVIDUAL_CONTRIBUTION_EXCEEDED"
        );

        if (!contributors[msg.sender].exists) {
            // Register all contributors, for Stream token releasing and token purchase tracking
            _addContributor(msg.sender);
        }

        unchecked {
            // Based on above checks, these cannot overflow
            totalContributions += value;
            availableFunds += value;
            contributors[msg.sender].contributions += value;
        }
        uint256 tokens = _ETHtostrm(value);

        if (phase == Phase.OPEN) {
            // Stream token have already been released: immediately release all new purchases
            token.transfer(msg.sender, tokens);
        }

        emit strmPurchased(msg.sender, uint80(tokens));
    }

    /// Push unclaimed Stream Token "STRM" to contributors during the OPEN phase via ERC721 increaseAllowance().
    function claimstrm() external {
        require(phase == Phase.OPEN, "INVALID_PHASE");
        Contributor storage contributor = contributors[msg.sender];
        require(contributor.exists, "NOT_CONTRIBUTOR");
        uint80 unclaimedstrm = (contributor.contributions * STRM_PER_ETH) -
            contributor.claimedstrm;
        require(unclaimedstrm > 0, "NO_UNCLAIMED_strm");

        contributors[msg.sender].claimedstrm += unclaimedstrm;
        token.increaseAllowance(address(this), unclaimedstrm);
        token.transferFrom(address(this), msg.sender, unclaimedstrm);
    }

    /// Toggle pausing of purchase capability
    /// @param _pause Whether to pause (true) or unpause (false) purchasing
    function pause(bool _pause) external onlyOwner {
        paused = _pause;
        emit IsPaused(paused);
    }

    /// Advance the StreamDAOs ICO to the next phase
    /// @param newPhase The next phase being moved to. GENERAL phase can be intentionally skipped.
    function advancePhase(Phase newPhase) external onlyOwner {
        require(
            phase != Phase.OPEN && uint8(newPhase) > uint8(phase),
            "INVALID_PHASE"
        );

        if (newPhase == Phase.GENERAL) {
            phase = Phase.GENERAL;
            phaseLimit = GENERAL_TOTAL;
            individualLimit = GENERAL_INDIVIDUAL;
            emit PhaseStarted("General", GENERAL_TOTAL, GENERAL_INDIVIDUAL);
        } else {
            // OPEN
            phase = Phase.OPEN;
            phaseLimit = GENERAL_TOTAL;
            individualLimit = GENERAL_TOTAL;
            emit PhaseStarted("Open", GENERAL_TOTAL, GENERAL_TOTAL);
        }
    }

    function withdrawToTreasury(uint80 amount) external {
        require(msg.sender == treasury, "NOT_TREASURY");
        require(phase == Phase.OPEN, "NOT_OPEN");
        require(amount <= availableFunds, "INVALID_AMOUNT");

        availableFunds -= amount;

        // solhint-disable-next-line
        (bool sent, ) = msg.sender.call{value: amount}("");
        require(sent, "Failed to send Ether");

        emit WithdrawToTreasury(amount);
    }
}
