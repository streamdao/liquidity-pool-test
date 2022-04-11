import { expect, assert } from "chai";
import { artifacts, ethers, waffle } from "hardhat";
import type { Artifact } from "hardhat/types";
import type { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";

import type { StreamToken, StreamTokenIco } from "../typechain";
import { Signers } from "./types";

import {deployMockContract} from '@ethereum-waffle/mock-contract';
import StreamTokenRouter from "../artifacts/contracts/StreamTokenRouter.sol/StreamTokenRouter.json";

describe("StreamTokenIco", function () {

  enum Phase { SEED=0, GENERAL=1, OPEN=2 }

  const STRM_PER_ETH: number = 5;

  const parseEther = ethers.utils.parseEther
  const parseSTRM = ethers.utils.parseEther

  let mockRouter: any;
  let ico: StreamTokenIco;
  let token: StreamToken;

  let owner: SignerWithAddress;
  let treasury: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let addrs: SignerWithAddress[];
  let seedInvestors: SignerWithAddress[]; // whitelisted
  let generalInvestors: SignerWithAddress[]; // pool of wallets for testing contribution limits
  let openInvestors: SignerWithAddress[]; // pool of wallets for testing contribution limits

  beforeEach(async function () {
    [owner, treasury, alice, bob, ...addrs] = await ethers.getSigners();
    seedInvestors = addrs.slice(0,19);
    generalInvestors = addrs.slice(20,39);
    openInvestors = addrs.slice(40,95);

    let whitelistAddrs = seedInvestors.map(w => w.address);

    mockRouter = await deployMockContract(owner, StreamTokenRouter.abi);
    let icoFactory = await ethers.getContractFactory("StreamTokenIco");
    ico = <StreamTokenIco>await icoFactory.deploy(treasury.address, whitelistAddrs);
    await ico.deployed()

    let tokenArtifact = await artifacts.readArtifact("StreamToken");
    token = <StreamToken>new ethers.Contract(await ico.token(), tokenArtifact.abi, ethers.provider);
  });

  describe("::Unit::", async function () {
    describe("Initial state", function () {
      it("is in Phase Seed", async function() {
        expect(await ico.phase()).to.equal(Phase.SEED);
      });

      it("is not paused", async function() {
        expect(await ico.paused()).to.be.false;
      });

      it("totalContributions() is 0", async function() {
        expect(await ico.totalContributions()).to.equal(0);
      });
    });

    it("advancePhase() reverts if not owner", async function() {
      await expect(ico.connect(alice).advancePhase(Phase.GENERAL)).to.be.
        revertedWith("NOT_OWNER")
    });

    it("pause() reverts if not owner", async function() {
      await expect(ico.connect(alice).pause(true)).to.be.
        revertedWith("NOT_OWNER")
    });

    it("buystrm() reverts when paused", async function() {
      await ico.connect(owner).pause(true);
      await expect(ico.connect(addrs[0]).buystrm({value: parseEther("1")})).to.be.
        revertedWith("PAUSED");
    });

    it("buystrm() reverts if 0 ETH", async function() {
      await expect(ico.connect(seedInvestors[0]).buystrm({value: 0})).to.be.
        revertedWith("INVALID_AMOUNT");
    });
  });

  describe("::BEHAVIOR::", async function () {
    describe("Phase Seed", async function() {
      describe("STRM purchases", async function() {
        it("revert if purchaser is not whitelisted", async function() {
          await expect(ico.connect(alice).buystrm({value: parseEther("1")})).to.be.
            revertedWith("NOT_WHITELISTED");
        });

        it("are capped to 15,000 ETH total", async function() {
          // Contribute 15,000, respecting the max individual contributions:
          for(let i: number = 0; i < 10; i++) {
            await ico.connect(seedInvestors[i]).buystrm({value: parseEther("1500")});
          }

          expect(await ico.totalContributions()).to.equal(parseEther("15000"));

          // 1 wei over 15000 - for the next new contributor - should bomb
          await expect(ico.connect(seedInvestors[10]).buystrm({value: 1})).to.be.
            revertedWith("TOTAL_CONTRIBUTION_EXCEEDED");
        });

        it("are capped to 1,500 ETH per individual", async function() {
          await ico.connect(seedInvestors[0]).buystrm({value: parseEther("1000")});
          await ico.connect(seedInvestors[0]).buystrm({value: parseEther("500")});

          // 1 wei over 1500 - for the same contributor - should bomb
          await expect(ico.connect(seedInvestors[0]).buystrm({value: 1})).to.be.
            revertedWith("INDIVIDUAL_CONTRIBUTION_EXCEEDED");
        });

        it("do not release STRM tokens", async function() {
          // buy some Stream tokens
          await ico.connect(seedInvestors[0]).buystrm({value: parseEther("1")});

          // not released yet!
          await expect(ico.connect(seedInvestors[0]).claimstrm()).to.be.
            revertedWith("INVALID_PHASE");
        });

        it("are correctly reflected by tokensPurchased()", async function() {
          // buy some Stream tokens
          await ico.connect(seedInvestors[0]).buystrm({value: parseEther("1")});
          await ico.connect(seedInvestors[1]).buystrm({value: parseEther("2")});
          await ico.connect(seedInvestors[2]).buystrm({value: parseEther("3")});

          expect(await ico.tokensPurchased(seedInvestors[0].address)).to.equal(parseSTRM("5"));
          expect(await ico.tokensPurchased(seedInvestors[1].address)).to.equal(parseSTRM("10"));
          expect(await ico.tokensPurchased(seedInvestors[2].address)).to.equal(parseSTRM("15"));
        });
      });

      it("cannot withdraw to treasury", async function() {
        await expect(ico.connect(treasury).withdrawToTreasury(1)).to.be.
          revertedWith("NOT_OPEN");
      });

      describe("phase", async function() {
        it("advances to General next", async function() {
          await ico.connect(owner).advancePhase(Phase.GENERAL);
          expect(await ico.phase()).to.equal(Phase.GENERAL);
        });
      });
    });

    describe("Phase General", async function() {
      describe("STRM purchases", async function() {
        it("are allowed by anyone", async function() {
          await ico.connect(owner).advancePhase(Phase.GENERAL);
          await ico.connect(seedInvestors[0]).buystrm({value: parseEther("1")});
          await ico.connect(alice).buystrm({value: parseEther("1")});
          await ico.connect(treasury).buystrm({value: parseEther("1")});
        });

        it("are capped to 30,000 ETH total", async function() {
          // Seed: Contribute 15k ETH, respecting the max individual contributions:
          for(let i: number = 0; i < 10; i++) {
            await ico.connect(seedInvestors[i]).buystrm({value: parseEther("1500")});
          }
          expect(await ico.totalContributions()).to.equal(parseEther("15000"));
          await ico.connect(owner).advancePhase(Phase.GENERAL);

          // General: Contribute 15k ETH, respecting the max individual contributions:
          for(let i: number = 0; i < 15; i++) {
            await ico.connect(generalInvestors[i]).buystrm({value: parseEther("1000")});
          }
          expect(await ico.totalContributions()).to.equal(parseEther("30000"));

          // 1 wei over 30000 - for the next new contributor - should bomb
          await expect(ico.connect(alice).buystrm({value: 1})).to.be.
            revertedWith("TOTAL_CONTRIBUTION_EXCEEDED");
        });

        it("are capped to 1,000 ETH per individual", async function() {
          // SEED
          // seedInvestor[0] only contributes 1000, which should prevent them from further contributions in General.
          await ico.connect(seedInvestors[0]).buystrm({value: parseEther("1000")});
          // seedInvestors[1] contributes 999, so they should be able to invest 1 ETH more in General.
          await ico.connect(seedInvestors[1]).buystrm({value: parseEther("999")});
          await ico.connect(owner).advancePhase(Phase.GENERAL);

          // GENERAL
          // seedInvestors[1] comes back to contribute the 1 ETH.
          await ico.connect(seedInvestors[1]).buystrm({value: parseEther("1")});
          // generalInvestors[0] caps out General contributions.  No more allowed
          await ico.connect(generalInvestors[0]).buystrm({value: parseEther("1000")});

          // Any contribution that exceeds the new 1000 ETH limit should bomb
          await expect(ico.connect(seedInvestors[0]).buystrm({value: 1})).to.be.
            revertedWith("INDIVIDUAL_CONTRIBUTION_EXCEEDED");
          await expect(ico.connect(seedInvestors[1]).buystrm({value: 1})).to.be.
            revertedWith("INDIVIDUAL_CONTRIBUTION_EXCEEDED");
          await expect(ico.connect(generalInvestors[0]).buystrm({value: 1})).to.be.
            revertedWith("INDIVIDUAL_CONTRIBUTION_EXCEEDED");
        });

        it("do not release STRM tokens", async function() {
          await ico.connect(owner).advancePhase(Phase.GENERAL);

          // buy some tokens
          await ico.connect(alice).buystrm({value: parseEther("1")});

          // not released yet!
          await expect(ico.connect(alice).claimstrm()).to.be.
            revertedWith("INVALID_PHASE");
        });

        it("are correctly reflected by tokensPurchased()", async function() {
          await ico.connect(owner).advancePhase(Phase.GENERAL);

          // buy some tokens
          await ico.connect(generalInvestors[0]).buystrm({value: parseEther("1")});
          await ico.connect(generalInvestors[1]).buystrm({value: parseEther("2")});
          await ico.connect(generalInvestors[2]).buystrm({value: parseEther("3")});

          expect(await ico.tokensPurchased(generalInvestors[0].address)).to.equal(parseSTRM("5"));
          expect(await ico.tokensPurchased(generalInvestors[1].address)).to.equal(parseSTRM("10"));
          expect(await ico.tokensPurchased(generalInvestors[2].address)).to.equal(parseSTRM("15"));
        });
      });

      it("cannot withdraw to treasury", async function() {
        await expect(ico.connect(treasury).withdrawToTreasury(1)).to.be.
          revertedWith("NOT_OPEN");
      });

      describe("phase advance", async function() {
        it("moves to Open next", async function() {
          await ico.connect(owner).advancePhase(Phase.GENERAL);
          await ico.connect(owner).advancePhase(Phase.OPEN);
          expect(await ico.phase()).to.equal(Phase.OPEN);
        });

        it("releases STRM tokens for existing contributions", async function() {
          // seed investment
          await ico.connect(seedInvestors[0]).buystrm({value: parseEther("100")});
          await ico.connect(owner).advancePhase(Phase.GENERAL);

          // general investment
          await ico.connect(seedInvestors[0]).buystrm({value: parseEther("100")});
          await ico.connect(generalInvestors[0]).buystrm({value: parseEther("1000")});
          await ico.connect(owner).advancePhase(Phase.OPEN);

          // Tokens for all prior contributions can be claimed
          await ico.connect(seedInvestors[0]).claimstrm();
          expect(await token.balanceOf(seedInvestors[0].address)).to.equal(parseSTRM("1000"));
          await ico.connect(generalInvestors[0]).claimstrm();
          expect(await token.balanceOf(generalInvestors[0].address)).to.equal(parseSTRM("5000"));
        });
      });
    });

    describe("Phase Open", async function() {
      describe("STRM purchases", async function() {
        beforeEach(async function() {
          await ico.connect(owner).advancePhase(Phase.OPEN);
        });

        it("are allowed by anyone", async function() {
          await ico.connect(seedInvestors[0]).buystrm({value: parseEther("1")});
          await ico.connect(alice).buystrm({value: parseEther("1")});
          await ico.connect(owner).buystrm({value: parseEther("1")});
          await ico.connect(treasury).buystrm({value: parseEther("1")});
        });

        it("are capped to 30,000 ETH total with no individual cap", async function() {
          // Alice is a rich lady
          await ico.connect(alice).buystrm({value: parseEther("30000")});

          // 1 wei over 30000 - for SAME contributor - should bomb
          await expect(ico.connect(alice).buystrm({value: 1})).to.be.
            revertedWith("TOTAL_CONTRIBUTION_EXCEEDED");
          // 1 wei over 30000 - for NEW contributor - should bomb
          await expect(ico.connect(bob).buystrm({value: 1})).to.be.
            revertedWith("TOTAL_CONTRIBUTION_EXCEEDED");
        });

        it("immediately release STRM tokens", async function() {
          // buy some tokens
          await ico.connect(alice).buystrm({value: parseEther("100")});
          await ico.connect(alice).buystrm({value: parseEther("10")});
          await ico.connect(bob).buystrm({value: parseEther("20")});

          // released!
          expect(await token.balanceOf(alice.address)).to.equal(parseSTRM("550"));
          expect(await token.balanceOf(bob.address)).to.equal(parseSTRM("100"));
        });


        it("are correctly reflected by tokensPurchased()", async function() {
          // buy some tokens
          await ico.connect(alice).buystrm({value: parseEther("100")});
          await ico.connect(alice).buystrm({value: parseEther("10")});
          await ico.connect(bob).buystrm({value: parseEther("20")});

          expect(await ico.tokensPurchased(alice.address)).to.equal(parseSTRM("550"));
          expect(await ico.tokensPurchased(bob.address)).to.equal(parseSTRM("100"));
        });
      });

      describe("treasury withdrawal", async function() {
        it("reverts if not treasury", async function() {
          await ico.connect(owner).advancePhase(Phase.OPEN);
          await expect(ico.connect(owner).withdrawToTreasury(1)).to.be.
            revertedWith("NOT_TREASURY");
        });

        it("sends funds to treasury when funds are available", async function() {
          // SEED
          await ico.connect(seedInvestors[0]).buystrm({value: parseEther("1000")});
          await ico.connect(owner).advancePhase(Phase.GENERAL);

          // GENERAL
          await ico.connect(generalInvestors[0]).buystrm({value: parseEther("1000")});
          await ico.connect(owner).advancePhase(Phase.OPEN);

          // OPEN
          // Withdraw funds
          await expect(await ico.connect(treasury).withdrawToTreasury(parseEther("1000"))).to.
            changeEtherBalance(treasury, parseEther("1000"));
          await expect(await ico.connect(treasury).withdrawToTreasury(parseEther("1000"))).to.
            changeEtherBalance(treasury, parseEther("1000"));

          // Attempt another withdrawal, without any new funds being provided
          await expect(ico.connect(treasury).withdrawToTreasury(1)).to.be.
            revertedWith("INVALID_AMOUNT");

          // Provide some more funds, and withdraw
          await ico.connect(alice).buystrm({value: parseEther("10")});
          await ico.connect(bob).buystrm({value: parseEther("20")});
          await expect(await ico.connect(treasury).withdrawToTreasury(parseEther("30"))).to.
            changeEtherBalance(treasury, parseEther("30"));

          // Attempt another withdrawal, without any new funds being provided
          await expect(ico.connect(treasury).withdrawToTreasury(1)).to.be.
            revertedWith("INVALID_AMOUNT");
        });
      });

      describe("phase", async function() {
        it("cannot be advanced further", async function() {
          await ico.connect(owner).advancePhase(Phase.OPEN);
          await expect(ico.connect(owner).advancePhase(Phase.OPEN)).to.be.
            revertedWith("INVALID_PHASE");
        });
      });
    });

    // ADDITIONAL TAX TESTS
    describe("taxes", async function() {
      it("are not extracted from initial Stream token purchases", async function() {
        // Enable taxes and buy some STRM in all the phases
        token.connect(treasury).enableTax(true);

        // Seed
        await ico.connect(addrs[0]).buystrm({value: parseEther("100")});
        await ico.connect(owner).advancePhase(Phase.GENERAL);
        // General
        await ico.connect(addrs[0]).buystrm({value: parseEther("100")});
        await ico.connect(owner).advancePhase(Phase.OPEN);
        // Open
        await ico.connect(addrs[0]).buystrm({value: parseEther("100")});

        // Even with taxing on, no taxes taken for initial purchases
        await expect(() => ico.connect(addrs[0]).claimstrm()).to.
          changeTokenBalance(token, addrs[0], parseSTRM("1500"));
      });

      it("are extracted from token transfers when taxing is enabled", async function() {
        // treasury starts out with 350000 non-ICO tokens
        let initialBalance = parseEther("350000");

        // Bump to General and buy tokens to play with
        await ico.connect(owner).advancePhase(Phase.OPEN);
        await ico.connect(alice).buystrm({value: parseEther("400")});

        // Taxing DISABLED
        // transfer()
        await token.connect(alice).transfer(bob.address, parseEther("100"));
        expect(await token.balanceOf(treasury.address)).to.equal(initialBalance);
        expect(await token.balanceOf(bob.address)).to.equal(parseEther("100"));
        // transferFrom()
        await token.connect(alice).approve(bob.address, parseEther("100"));
        await token.connect(bob).transferFrom(alice.address, bob.address, parseEther("100"));
        expect(await token.balanceOf(treasury.address)).to.equal(initialBalance);
        expect(await token.balanceOf(bob.address)).to.equal(parseEther("200"));

        // Taxing ENABLED
        await token.connect(treasury).enableTax(true);
        // transfer()
        await token.connect(alice).transfer(bob.address, parseEther("100"));
        expect(await token.balanceOf(treasury.address)).to.equal(initialBalance.add(parseEther("2")));
        expect(await token.balanceOf(bob.address)).to.equal(parseEther("298"));
        // transferFrom()
        await token.connect(alice).approve(bob.address, parseEther("100"));
        await token.connect(bob).transferFrom(alice.address, bob.address, parseEther("100"));
        expect(await token.balanceOf(treasury.address)).to.equal(initialBalance.add(parseEther("4")));
        expect(await token.balanceOf(bob.address)).to.equal(parseEther("396"));
      });
    });
  });
});
