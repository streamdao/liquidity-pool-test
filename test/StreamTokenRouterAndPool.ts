import { expect, assert } from "chai";
import { artifacts, ethers, waffle } from "hardhat";
import type { Artifact } from "hardhat/types";
import type { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";

import type { StreamToken, StreamTokenIco, StreamTokenRouter, StreamTokenPool } from "../typechain";
import { Signers } from "./types";

import {deployMockContract} from '@ethereum-waffle/mock-contract';
import { BigNumber } from "ethers";

// Shared by StreamDAO
const ONE = ethers.BigNumber.from(1);
const TWO = ethers.BigNumber.from(2);
function sqrt(value: BigNumber): BigNumber {
  const x = value;
  let z = x.add(ONE).div(TWO);
  let y = x;
  while (z.sub(y).isNegative()) {
    y = z;
    z = x.div(z).add(z).div(TWO);
  }
  return y;
}

describe("StreamTokenRouter & StreamTokenPool", function () {

  enum Phase { SEED=0, GENERAL=1, OPEN=2 }

  const STRM_PER_ETH: number = 5;

  const parseEther = ethers.utils.parseEther
  const parseSTRM = ethers.utils.parseEther
  const parseValue = ethers.utils.parseEther

  let ico: StreamTokenIco;
  let token: StreamToken;
  let router: StreamTokenRouter;
  let pool: StreamTokenPool;

  let owner: SignerWithAddress;
  let treasury: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let carol: SignerWithAddress;
  let addrs: SignerWithAddress[];

  beforeEach(async function () {
    [owner, treasury, alice, bob, carol, ...addrs] = await ethers.getSigners();

    let icoFactory = await ethers.getContractFactory("StreamTokenIco");
    ico = <StreamTokenIco>await icoFactory.deploy(treasury.address, []);
    await ico.deployed();

    let tokenArtifact = await artifacts.readArtifact("StreamToken");
    token = <StreamToken>new ethers.Contract(await ico.token(), tokenArtifact.abi, ethers.provider);

    let poolFactory = await ethers.getContractFactory("StreamTokenPool");
    pool = <StreamTokenPool>await poolFactory.deploy(token.address);
    await pool.deployed();

    let routerFactory = await ethers.getContractFactory("StreamTokenRouter");
    router = <StreamTokenRouter>await routerFactory.deploy(token.address, pool.address);
    await router.deployed();
  });

  describe("::ROUTER::", async function () {
    describe("liquidity", async function() {
      beforeEach(async function() {
        // Move to OPEN with 30K ETH contributed
        ico.connect(owner).advancePhase(Phase.OPEN);
        ico.connect(alice).buystrm({value: parseEther("30000")});
      });

      it("can withdraw ICO contributions", async function() {
        await expect(await ico.connect(treasury).withdrawToTreasury(parseEther("30000"))).to.
          changeEtherBalance(treasury, parseEther("30000"));
      });

      it("can add liquidity to pool", async function() {
        let ethAmount = parseEther("30000");
        let strmAmount = parseSTRM("150000");
        let strmInitialBalance = await token.balanceOf(treasury.address);

        // Withdraw funds
        await ico.connect(treasury).withdrawToTreasury(ethAmount);

        // Expect 0 liquidity tokens initially
        expect(await pool.balanceOf(treasury.address)).to.equal(0);

        // Add liquidity
        await token.connect(treasury).increaseAllowance(router.address, strmAmount);
        await expect(
          await router.connect(treasury).addLiquidity(strmAmount, treasury.address, {value: ethAmount})
        ).to.
          changeEtherBalances([treasury, pool], [ethAmount.mul(-1), ethAmount]).
          emit(pool, 'LiquidityAdded').withArgs(treasury.address, strmAmount, ethAmount).
          emit(pool, 'Reserves').withArgs(strmAmount, ethAmount);

        // Confirm Stream Token "STRM" transferred out of Treasury
        let strmFinalBalance = await token.balanceOf(treasury.address);
        expect(strmInitialBalance.sub(strmAmount)).to.equal(strmFinalBalance);

        // Confirm Stream Token "STRM" transferred to Pool
        expect(await token.balanceOf(pool.address)).to.equal(strmAmount);
        expect(await pool.strmReserve()).to.equal(strmAmount);
        // Confirm ETH transferred to Pool
        expect(await pool.ethReserve()).to.equal(ethAmount);

        // Confirm Stream Liquidity Tokens
        let expectedLiquidity = sqrt(strmAmount.mul(ethAmount)).sub(1000);
        expect(await pool.balanceOf(treasury.address)).to.equal(expectedLiquidity);
      });

      it("can remove stream pool liquidity", async function() {
        let ethAmount = parseEther("30000");
        let strmAmount = parseSTRM("150000");

        // Add liquidity - in twp batches to test both mint() codepaths
        await ico.connect(treasury).withdrawToTreasury(ethAmount);
        await token.connect(treasury).increaseAllowance(router.address, strmAmount);
        await router.connect(treasury).
          addLiquidity(strmAmount.div(2), treasury.address, {value: ethAmount.div(2)})
        await router.connect(treasury).
          addLiquidity(strmAmount.div(2), treasury.address, {value: ethAmount.div(2)})

        let liquidityToBurn = await pool.balanceOf(treasury.address);
        let liquiditySupply = await pool.totalSupply();
        let ethPreBalance: BigNumber = await ethers.provider.getBalance(pool.address);
        let strmPreBalance: BigNumber = await token.balanceOf(pool.address);
        let strmReturnAmount = liquidityToBurn.mul(strmPreBalance).div(liquiditySupply);
        let ethReturnAmount = liquidityToBurn.mul(ethPreBalance).div(liquiditySupply);
        let strmPostBalance = strmPreBalance.sub(strmReturnAmount);
        let ethPostBalance = ethPreBalance.sub(ethReturnAmount);

        let strmInitialBalance = await token.balanceOf(treasury.address);

        // Remove liquidity
        await pool.connect(treasury).increaseAllowance(router.address, liquidityToBurn);
        await expect(
          await router.connect(treasury).
            removeLiquidity(liquidityToBurn, strmReturnAmount, ethReturnAmount, treasury.address)
        ).to.
          changeEtherBalances([treasury, pool], [ethReturnAmount, ethReturnAmount.mul(-1)]).
          emit(pool, 'LiquidityRemoved').withArgs(treasury.address, strmReturnAmount, ethReturnAmount).
          emit(pool, 'Reserves').withArgs(strmPostBalance, ethPostBalance);

        // Confirm Stream Token "STRM" transferred out of Pool
        expect(await token.balanceOf(pool.address)).to.equal(strmPostBalance);

        // Confirm Stream Token "STRM" transferred to Treasury
        let strmFinalBalance = await token.balanceOf(treasury.address);
        expect(strmInitialBalance.add(strmReturnAmount)).to.equal(strmFinalBalance);
        expect(await pool.strmReserve()).to.equal(strmPostBalance);
        // Confirm ETH transferred to Treasury
        expect(await pool.ethReserve()).to.equal(ethPostBalance);

        // Confirm Stream Liquidity Tokens
        expect(await pool.balanceOf(treasury.address)).to.equal(0);
        expect(await pool.totalSupply()).to.equal(1000);
      });
    });

    describe("swapping", async function() {
      beforeEach(async function() {
        let ethAmount = parseEther("10000");
        let strmAmount = parseSTRM("50000");

        // Move to OPEN with 30K ETH contributed
        await ico.connect(owner).advancePhase(Phase.OPEN);
        await ico.connect(alice).buystrm({value: ethAmount});
        await ico.connect(bob).buystrm({value: ethAmount});

        // Alice adds liquidity
        await token.connect(alice).increaseAllowance(router.address, strmAmount);
        await router.connect(alice).addLiquidity(strmAmount, alice.address, {value: ethAmount});
        // Bob adds liquidity
        await token.connect(bob).increaseAllowance(router.address, strmAmount);
        await router.connect(bob).addLiquidity(strmAmount, bob.address, {value: ethAmount});
      });

      describe("with Stream Token tax disabled", async function() {
        beforeEach(async function() {
          await token.connect(treasury).enableTax(false);
        });

        it("can swap STRM for ETH", async function() {
          let trader = addrs[0];
          let strmIn = parseSTRM("100");

          // Buy STRM and grant sufficient token allowance to router
          await ico.connect(trader).buystrm({value: parseSTRM("100")});
          await token.connect(trader).increaseAllowance(router.address, strmIn);

          let ethBalanceBefore = await ethers.provider.getBalance(trader.address);

          // Swap with unmet ETH min (should fail)
          await expect(
            router.connect(trader).swapSTRMforETH(strmIn, parseEther("20"), trader.address)
          ).to.be.revertedWith("UNMET_MIN_RETURN");

          // Swap
          await expect(
            () => router.connect(trader).swapSTRMforETH(strmIn, parseEther("19"), trader.address)
          ).to.changeTokenBalance(token, trader, strmIn.mul(-1));

          let ethBalanceAfter = await ethers.provider.getBalance(trader.address);

          expect(ethBalanceAfter.sub(ethBalanceBefore)).to.be.
            lt(parseEther("19.8")).and.
            gt(parseEther("19.7"));
        });

        it("can swap ETH for STRM", async function() {
          let trader = addrs[0];
          let ethIn = parseEther("100");
          let strmOut = parseSTRM("492");

          let ethBalanceBefore = await ethers.provider.getBalance(trader.address);
          let strmBalanceBefore = await token.balanceOf(trader.address);

          // Swap with unmet STRM MIN (should fail)
          await expect(
            router.connect(trader).swapETHforSTRM(parseSTRM("500"), trader.address, {value: ethIn})
          ).to.be.revertedWith("UNMET_MIN_RETURN");

          // Swap
          await expect(
            router.connect(trader).swapETHforSTRM(strmOut, trader.address, {value: ethIn})
          ).to.not.be.reverted;

          let ethBalanceAfter = await ethers.provider.getBalance(trader.address);
          let strmBalanceAfter = await token.balanceOf(trader.address);

          expect(ethBalanceBefore.sub(ethBalanceAfter)).to.be.
            lt(parseEther("100.1")).and.
            gt(parseEther("100"));

          expect(strmBalanceAfter.sub(strmBalanceBefore)).to.be.
            lt(parseEther("493")).and.
            gt(parseEther("492"));
        });
      });

      describe("with STRM tax enabled", async function() {
        beforeEach(async function() {
          await token.connect(treasury).enableTax(true);
        });

        it("can swap STRM for ETH", async function() {
          let trader = addrs[0];
          let strmIn = parseSTRM("100");

          // Buy STRM and grant sufficient token allowance to router
          await ico.connect(trader).buystrm({value: parseSTRM("100")});
          await token.connect(trader).increaseAllowance(router.address, strmIn);

          let ethBalanceBefore = await ethers.provider.getBalance(trader.address);

          // Swap with unmet ETH min (should fail)
          await expect(
            router.connect(trader).swapSTRMforETH(strmIn, parseEther("20"), trader.address)
          ).to.be.revertedWith("UNMET_MIN_RETURN");

          // Swap
          await expect(
            () => router.connect(trader).swapSTRMforETH(strmIn, parseEther("19"), trader.address)
          ).to.changeTokenBalance(token, trader, strmIn.mul(-1));

          let ethBalanceAfter = await ethers.provider.getBalance(trader.address);

          expect(ethBalanceAfter.sub(ethBalanceBefore)).to.be.
            lt(parseEther("19.4")).and.
            gt(parseEther("19.3"));
        });

        it("can swap ETH for STRM", async function() {
          let trader = addrs[0];
          let ethIn = parseEther("100");
          let strmOut = parseSTRM("482");

          let ethBalanceBefore = await ethers.provider.getBalance(trader.address);
          let strmBalanceBefore = await token.balanceOf(trader.address);

          // Swap with unmet STRM MIN (should fail)
          await expect(
            router.connect(trader).swapETHforSTRM(parseSTRM("500"), trader.address, {value: ethIn})
          ).to.be.revertedWith("UNMET_MIN_RETURN");

          // Swap
          await expect(
            router.connect(trader).swapETHforSTRM(strmOut, trader.address, {value: ethIn})
          ).to.not.be.reverted;

          let ethBalanceAfter = await ethers.provider.getBalance(trader.address);
          let strmBalanceAfter = await token.balanceOf(trader.address);

          expect(ethBalanceBefore.sub(ethBalanceAfter)).to.be.
            lt(parseEther("101")).and.
            gt(parseEther("100"));

          expect(strmBalanceAfter.sub(strmBalanceBefore)).to.be.
            lt(parseEther("483")).and.
            gt(parseEther("482"));
        });
      });
    });
  });

  describe("::POOL::", async function() {
    describe("sync", async function() {
      beforeEach(async function() {
        await ico.connect(owner).advancePhase(Phase.OPEN);
      });

      it("updates reserves with direct transfers", async function() {
        let strmAmount = parseSTRM("50");

        // Alice accidentally sends 50 STRM directly to the Pool
        await ico.connect(alice).buystrm({value: strmAmount});
        await token.connect(alice).increaseAllowance(alice.address, strmAmount);
        await token.connect(alice).transferFrom(alice.address, pool.address, strmAmount);

        // Expect the reserves to still show 0 STRM
        let strmReserve, ethReserve;
        [strmReserve, ethReserve] = await pool.getReserves();
        expect(strmReserve).to.equal(0);

        // Sync
        await pool.sync();

        // Expect the reserves to still show 50 STRM
        [strmReserve, ethReserve] = await pool.getReserves();
        expect(strmReserve).to.equal(parseSTRM("50"));
      });
    });
  });
});
