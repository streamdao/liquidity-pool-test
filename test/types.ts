import type { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import type { Fixture } from "ethereum-waffle";

import type { StreamToken } from "../typechain/StreamToken";
import type { StreamTokenIco } from "../typechain/StreamTokenIco";

declare module "mocha" {
  export interface Context {
    token: StreamToken;
    ico: StreamTokenIco;
    loadFixture: <T>(fixture: Fixture<T>) => Promise<T>;
    signers: Signers;
  }
}

export interface Signers {
  admin: SignerWithAddress;
}
