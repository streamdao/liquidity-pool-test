// SPDX-License-Identifier: MIT
pragma solidity >=0.8.9;

import "hardhat/console.sol";

import "./StreamToken.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title StreamTokenPool
 * @author StreamDAO [contact@streamdao.org]
 * @notice STRM-ETH liquidity pool
 */
contract StreamTokenPool is ERC20 {
    // Minimum liquidity always in existence, once liquidity is added
    uint256 public constant MIN_LIQUIDITY = 1e3;

    uint256 public strmReserve;
    uint256 public ethReserve;
    StreamToken private strm;
    // nonReentrant()
    uint8 private lock = 1;

    /// Event upon successful addLiquidity()
    /// @param to Liquidity minted to
    /// @param strmAdded STRM added to the pool
    /// @param ethAdded ETH added to the pool
    event LiquidityAdded(address to, uint256 strmAdded, uint256 ethAdded);

    /// Event upon successful removeLiquidity()
    /// @param to Liquidity burned from
    /// @param strmRemoved STRM removed from the pool
    /// @param ethRemoved ETH removed from the pool
    event LiquidityRemoved(address to, uint256 strmRemoved, uint256 ethRemoved);

    /// Event when reserves are updated
    /// @param strmReserve New STRM reserve value
    /// @param ethReserve New ETH reserve value
    event Reserves(uint256 strmReserve, uint256 ethReserve);

    /// Constructor
    /// @param _strm StreamToken address
    constructor(address _strm) ERC20("STRM Liquidity Pool", "strmL") {
        strm = StreamToken(_strm);
    }

    /// Prevent re-entrancy
    modifier nonReentrant() {
        require(lock == 1, "NO_REENTRY");
        lock = 2;
        _;
        lock = 1;
    }

    /// Get present reserve amounts
    /// @return strmR STRM reserve amount
    /// @return ethR ETH reserve amount
    function getReserves() external view returns (uint256 strmR, uint256 ethR) {
        strmR = strmReserve;
        ethR = ethReserve;
    }

    /// Button up accounting after every material change via swap or liquidity ops
    /// @param strmBalance The new STRM reserve amount
    /// @param ethBalance The new ETH reserve amount
    function _updateReserves(uint256 strmBalance, uint256 ethBalance) internal {
        strmReserve = strmBalance;
        ethReserve = ethBalance;
        emit Reserves(strmReserve, ethReserve);
    }

    // source: https://github.com/Uniswap/v2-core/blob/master/contracts/libraries/Math.sol
    // babylonian method (https://en.wikipedia.org/wiki/Methods_of_computing_square_roots#Babylonian_method)
    function _sqrt(uint256 y) internal pure returns (uint256 z) {
        if (y > 3) {
            z = y;
            uint256 x = y / 2 + 1;
            while (x < z) {
                z = x;
                x = (y / x + x) / 2;
            }
        } else if (y != 0) {
            z = 1;
        }
    }

    /// Mint liquidity tokens based on balances of ETH and STRM sent to the Pool
    /// @param _to Address to mint liquidity tokens to
    function mint(address _to) external payable {
        // STRM and ETH are expect to be sent in via Router. Capture new pool balances
        uint256 strmBalance = strm.balanceOf(address(this));
        uint256 ethBalance = address(this).balance;

        // Calculate STRM and ETH amounts sent in
        uint256 strmAdded = strmBalance - strmReserve;
        uint256 ethAdded = ethBalance - ethReserve;

        uint256 liquidity;
        uint256 _totalSupply = totalSupply();

        if (_totalSupply == 0) {
            // Initial liquidity provider has tiny amount of liquidity burned
            liquidity = _sqrt(strmAdded * ethAdded) - MIN_LIQUIDITY;
            /// @dev burning to address(1) because OZ has guard against address(0)
            _mint(address(1), MIN_LIQUIDITY);
        } else {
            // Further liquidity additions grant liquidity proportional to reserves and supply
            uint256 strmLiquidity = (strmAdded * _totalSupply) / strmReserve;
            uint256 ethLiquidity = (ethAdded * _totalSupply) / ethReserve;
            liquidity = strmLiquidity <= ethLiquidity
                ? strmLiquidity
                : ethLiquidity;
        }

        require(liquidity > 0, "INSUFFICIENT_LIQUIDITY_ADDED");
        _mint(_to, liquidity);
        emit LiquidityAdded(_to, strmAdded, ethAdded);
        _updateReserves(strmBalance, ethBalance);
    }

    /// Burn liquidity tokens and return corresponding STRM and ETH to the holder
    /// @param _to Address burning liquidity tokens and receiving STRM and ETH divestments
    /// @param _minAmountstrm Revert if STRM out does not meet this threshold. Should account for fees and transfer tax.
    /// @param _minAmountETH Revert if ETH out does not meet this threshold
    function burn(
        address payable _to,
        uint256 _minAmountstrm,
        uint256 _minAmountETH
    ) external nonReentrant {
        // Retrieve present balances prior to the liquidation
        uint256 strmBalance = strm.balanceOf(address(this));
        uint256 ethBalance = address(this).balance;
        uint256 liquidityToBurn = balanceOf(address(this));
        uint256 _totalSupply = totalSupply();

        // Calculate STRM/ETH divestments based on liquidity token holdings, and validate mins
        uint256 strmRemoved = (liquidityToBurn * strmBalance) / _totalSupply;
        uint256 ethRemoved = (liquidityToBurn * ethBalance) / _totalSupply;
        require(
            strmRemoved > 0 && ethRemoved > 0,
            "INSUFFICIENT_LIQUIDITY_REMOVED"
        );
        require(strmRemoved >= _minAmountSTRM, "UNMET_STRM");
        require(ethRemoved >= _minAmountETH, "UNMET_ETH");

        // Burn liquidity
        _burn(address(this), liquidityToBurn);

        // Transfer STRM and update pool balance
        strm.transfer(_to, strmRemoved);
        strmBalance = strm.balanceOf(address(this));

        // Transfer ETH and update pool balance
        (bool success, ) = _to.call{value: ethRemoved}("");
        require(success, "REMOVE_ETH_FAILED");
        ethBalance -= ethRemoved;

        emit LiquidityRemoved(_to, strmRemoved, ethRemoved);

        // Button up the accounting
        _updateReserves(strmBalance, ethBalance);
    }

    /// Swap ETH for STRM
    /// @param _strmOut STRM expected out
    /// @param _to Address to receive the STRM
    function swapETHforSTRM(uint256 _strmOut, address _to)
        external
        payable
        nonReentrant
    {
        require(_strmOut > 0, "INVALID_STRM_OUT");
        require(_strmOut < strmReserve, "INSUFFICIENT_STRM_RESERVE");

        // These balances reflect the post-swap state
        uint256 ethBalance = address(this).balance;
        uint256 strmBalance = strm.balanceOf(address(this)) - _strmOut;

        // validate constant product, accounting for tax
        require(
            strmBalance * (ethBalance * 100 - msg.value) >=
                strmReserve * ethReserve * 100,
            "INVALID_ETH_IN"
        );

        // Transfer STRM
        strm.transfer(_to, _strmOut);

        _updateReserves(strmBalance, ethBalance);
    }

    /// Swap STRM for ETH
    /// @param _ethOut ETH expected out
    /// @param _to Address to receive the STRM
    function swapSTRMforETH(uint256 _ethOut, address payable _to)
        external
        nonReentrant
    {
        require(_ethOut > 0, "INVALID_ETH_OUT");
        require(_ethOut < ethReserve, "INSUFFICIENT_ETH_RESERVE");

        // These balances reflect the post-swap state
        uint256 ethBalance = address(this).balance - _ethOut;
        uint256 strmBalance = strm.balanceOf(address(this));
        uint256 strmAmount = strmBalance - strmReserve;

        // validate against constant product, accounting for tax
        require(
            (strmBalance * 100 - strmAmount) * ethBalance >=
                strmReserve * ethReserve * 100,
            "INVALID_STRM_IN"
        );

        // Transfer ETH
        (bool success, ) = _to.call{value: _ethOut}("");
        require(success, "TRANSFER_ETH_FAILED");

        _updateReserves(strmBalance, ethBalance);
    }

    /// Prevent pool from becoming unusable due to mistaken direct transfers
    function sync() external nonReentrant {
        _updateReserves(strm.balanceOf(address(this)), address(this).balance);
    }
}
