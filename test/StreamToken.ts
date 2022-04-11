import { expect, assert } from "chai";
import { artifacts, ethers, waffle } from "hardhat";
import type { Artifact } from "hardhat/types";
import type { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";

import type { StreamToken } from "../typechain/StreamToken";
import { Signers } from "./types";


describe("StreamToken", function () {

  const parseEther = ethers.utils.parseEther;
  const parseSTRM = ethers.utils.parseEther;

  let tokenFactory;
  let token: StreamToken;
  let owner: SignerWithAddress;
  let treasury: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let addrs: SignerWithAddress[];

  describe("::Unit::", async function () {
    beforeEach(async function () {
      [owner, treasury, alice, bob, ...addrs] = await ethers.getSigners();

      let factory = await ethers.getContractFactory("StreamToken");
      token = <StreamToken>await factory.deploy(treasury.address);
      await token.deployed()
    });

    describe("Initial state", function () {
      it("has total supply of 500,000", async function () {
        expect(await token.totalSupply()).to.equal(parseSTRM("500000"));
      });

      it("StreamDAO owner owns 150,000 tokens", async function () {
        expect(await token.balanceOf(owner.address)).to.equal(parseSTRM("150000"));
      });

      it("Stream treasury owns 350,000 tokens", async function () {
        expect(await token.balanceOf(treasury.address)).to.equal(parseSTRM("350000"));
      });


      it("has tax disabled", async function () {
        expect(await token.currentTaxPercent()).to.equal(0);
      });
    });

    describe("ERC20", async function () {
      it("has expected name and symbol", async function () {
        expect(await token.name()).to.equal("Stream Token");
        expect(await token.symbol()).to.equal("STRM");
      });
    });

    describe("enableTax()", async function () {
      it("reverts if not treasury", async function () {
        await expect(token.connect(alice).enableTax(true)).to.be.revertedWith("ONLY_TREASURY");
      });

      it("enables and disables the tax flag", async function () {
        // enable taxing
        await token.connect(treasury).enableTax(true);
        expect(await token.currentTaxPercent()).to.equal(2);

        // disable taxing
        await token.connect(treasury).enableTax(false);
        expect(await token.currentTaxPercent()).to.equal(0);
      });

      // NOTE: See the StreamTokenIco tests for additional tax tests:
      // Search the file for "ADDITIONAL TAX TESTS"
    });
  });
});
