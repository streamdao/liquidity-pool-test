//SPDX-License-Identifier: MIT
pragma solidity >=0.8.9;

import "hardhat/console.sol";

import "./StreamToken.sol";
import "./StreamTokenPool.sol";

/**
 * @title StreamTokenRouter
 * @author StreamDAO [contact@streamdao.org]
 * @notice Manages interactions with the StreamToken and StreamTokenPool
 */
contract StreamTokenRouter {
    StreamToken private strm;
    StreamTokenPool private pool;

    /// Constructor
    /// @param _strm StreamToken address
    /// @param _pool StreamTokenPool address
    constructor(address _strm, address _pool) {
        strm = StreamToken(_strm);
        pool = StreamTokenPool(_pool);
    }

    /*
     * Liquidity
     */

    /// Add liquidity to the Pool
    /// @param _amountstrm STRM to add
    /// @param _to Address to mint Stream Liquidity Tokens to
    function addLiquidity(uint256 _amountstrm, address _to) external payable {
        // safely transfer STRM from msg.sender to pool
        strm.transferFrom(msg.sender, address(pool), _amountstrm);
        // mint liquidity tokens, sending any ETH
        pool.mint{value: msg.value}(_to);
    }

    /// Remove liquidity from the Pool
    /// @param _liquidity Liquidity token amount to remove
    /// @param _minAmountSTRM Revert if STRM returned is less than this value. Should account for Liquidity Pool fees and STRM transfer tax.
    /// @param _minAmountETH Revert if ETH returned is less than this value.
    /// @param _to Address to return ETH and STRM to
    function removeLiquidity(
        uint256 _liquidity,
        uint256 _minAmountSTRM,
        uint256 _minAmountETH,
        address payable _to
    ) external {
        // transfer msg.sender's liquidity back to the pool
        pool.transferFrom(msg.sender, address(pool), _liquidity);
        // burn liquidity tokens, transfering STRM and ETH if thresholds meet
        pool.burn(_to, _minAmountSTRM, _minAmountETH);
    }

    /*
     * Quote
     */

    /// Given an input amount of an asset and pair reserves, returns the maximum output amount of the other asset.
    /// @param amountIn Value of the token being sent in
    /// @param reserveIn Present value of the reserve correlating to amounIn token
    /// @param reserveOut Present value of the reserve correlating to the amountOut token
    /// @return Amount out value
    function _getAmountOut(
        uint256 amountIn,
        uint256 reserveIn,
        uint256 reserveOut
    ) internal pure returns (uint256) {
        require(reserveIn > 0 && reserveOut > 0, "INSUFFICIENT_LIQUIDITY");
        require(amountIn > 0, "INSUFFICIENT_AMOUNT");

        uint256 amountInWithFee = amountIn * 99;
        return
            (amountInWithFee * reserveOut) /
            ((reserveIn * 100) + amountInWithFee);
    }

    /// Apply STRM transfer tax, if any exists
    /// @param _strmAmount Value of STRM, pre-tax
    /// @return Value of STRM, post-tax
    function _applystrmTax(uint256 _strmAmount) internal view returns (uint256) {
        return (_strmAmount * (100 - strm.currentTaxPercent())) / 100;
    }

    /// Quote the value of STRM returned for a given ETH input
    /// @param _ethIn ETH input
    /// @return STRM out
    function quoteSwapETHforSTRM(uint256 _ethIn) public view returns (uint256) {
        (uint256 strmReserve, uint256 ethReserve) = pool.getReserves();
        // Determine the base swap value including only Pool fees
        uint256 untaxedstrmOut = _getAmountOut(_ethIn, ethReserve, strmReserve);
        // Apply any STRM transfer-tax on the output
        return _applystrmTax(untaxedstrmOut);
    }

    /// Quote the value of ETH returned for a given STRM input
    /// @param _strmIn STRM input
    /// @return ETH out
    function quoteSwapSTRMforETH(uint256 _strmIn) public view returns (uint256) {
        (uint256 strmReserve, uint256 ethReserve) = pool.getReserves();
        // Apply STRM transfer tax, which would be taken on the transfer-in to the pool
        uint256 taxedstrmIn = _applystrmTax(_strmIn);
        // Determine the swap value, also including Pool fees
        return _getAmountOut(taxedstrmIn, strmReserve, ethReserve);
    }

    /*
     * Swap
     */

    /// Swap ETH for STRM
    /// @param minstrmOut Revert if the STRM out is less than this threshold
    /// @param _to Address to receive STRM
    function swapETHforSTRM(uint256 minstrmOut, address _to) external payable {
        (uint256 strmReserve, uint256 ethReserve) = pool.getReserves();
        // Determine the pre-tax STRM output to pass into the swap method.
        // STRM taxes will get pulled out after conversion, on the transfer out of the pool.
        uint256 strmOutPretax = _getAmountOut(msg.value, ethReserve, strmReserve);

        // Check if the final STRM (including transfer tax) meets min requirement
        require(_applystrmTax(strmOutPretax) >= minstrmOut, "UNMET_MIN_RETURN");

        // Swap by declaring STRM out: the pool validates against ETH sent in
        pool.swapETHforSTRM{value: msg.value}(strmOutPretax, _to);
    }

    /// Swap STRM for ETH
    /// @param _strmIn STRM in
    /// @param _minEthOut Revert if the ETH out is less than this threshold
    /// @param _to Address to receive ETH
    function swapSTRMforETH(
        uint256 _strmIn,
        uint256 _minEthOut,
        address payable _to
    ) external {
        // quote ETH on the post-taxed value of STRM
        uint256 ethOut = quoteSwapSTRMforETH(_strmIn);
        require(ethOut >= _minEthOut, "UNMET_MIN_RETURN");

        // Transfer the pre-taxstrm into the pool, taxes taken out in transit
        strm.transferFrom(msg.sender, address(pool), _strmIn);

        // Swap by declaring ETH out: the pool validates against STRM sent in
        pool.swapSTRMforETH(ethOut, _to);
    }
}
