import { ethers } from "ethers"
import { BigNumber } from "bignumber.js"
import IcoJSON from '../../artifacts/contracts/StreamTokenIco.sol/StreamTokenIco.json'
import TokenJSON from '../../artifacts/contracts/StreamToken.sol/StreamToken.json'
import RouterJSON from '../../artifacts/contracts/StreamTokenRouter.sol/StreamTokenRouter.json'
import PoolJSON from '../../artifacts/contracts/StreamTokenPool.sol/StreamTokenPool.json'

const provider = new ethers.providers.Web3Provider(window.ethereum)
const signer = provider.getSigner()

const icoAddr = '0x5FbDB2315678afecb367f032d93F642f64180aa3'
const ico = new ethers.Contract(icoAddr, IcoJSON.abi, provider);

const routerAddr = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0'
const router = new ethers.Contract(routerAddr, RouterJSON.abi, provider);

const poolAddr = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512';
const pool = new ethers.Contract(poolAddr, PoolJSON.abi, provider);

const treasury = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

let token;
let icoPhase;
let icoStrmAvailable;
let strmPoolReserve = 0;
let ethPoolReserve = 0;
let currentStrmToEthPrice = 0.2;
let currentEthToStrmPrice = 5;

const Phase_SEED = 0;
const Phase_GENERAL = 1;
const Phase_OPEN = 2;

async function connectToMetamask() {
    try {
        console.log("Signed in as", await signer.getAddress())
    } catch (err) {
        console.log("Not signed in")
        await provider.send("eth_requestAccounts", [])
    }
}

window.onload = async() => {
    connectToMetamask();
    const tokenAddr = await ico.connect(signer).token();
    token = new ethers.Contract(tokenAddr, TokenJSON.abi, provider);
    await updateIcoPhase();
    await updateStrmAvailable();
    await updateEthFunds();
};

function clearError() {
    document.getElementById("error").innerText = '';
}

function displayError(err) {
    if (err.data && err.data.message) {
        document.getElementById("error").innerText = err.data.message;
    } else if (err.message) {
        document.getElementById("error").innerText = err.message;
    }
}

async function updateIcoPhase() {
    icoPhase = await ico.connect(signer).phase();
    console.log("Phase: ", icoPhase);
    const elem = document.getElementById('icoPhase');
    switch (icoPhase) {
        case Phase_SEED:
            elem.innerText = 'SEED';
            break;
        case Phase_GENERAL:
            elem.innerText = 'GENERAL';
            break;
        case Phase_OPEN:
            elem.innerText = 'OPEN';
            break;
    }
}

async function updateStrmAvailable() {
    let icoBalance = await token.connect(signer).balanceOf(icoAddr);
    document.getElementById('icoStrmAvailable').innerText = icoBalance / 1e18;
    let TreasurySTRM = await token.connect(signer).balanceOf(treasury);
    document.getElementById('icoTreasurySTRM').innerText = TreasurySTRM / 1e18;
}

async function updateEthFunds() {
    const icoETH = await ico.connect(signer).availableFunds();
    document.getElementById('icoETH').innerText = icoETH / 1e18;
    const treasuryETH = await provider.getBalance(treasury);
    document.getElementById('icoTreasuryETH').innerText = treasuryETH / 1e18;
}

async function updatePoolReserves() {
    [strmPoolReserve, ethPoolReserve] = await pool.connect(signer).getReserves();
    document.getElementById('lpStrmReserve').innerText = strmPoolReserve / 1e18;
    document.getElementById('lpEthReserve').innerText = ethPoolReserve / 1e18;
}

async function updateYourHoldings() {
    let yourAddr = await signer.getAddress();
    let yourEth = await signer.getBalance();
    document.getElementById('lpYourEth').innerText = yourEth / 1e18;
    let yourStrm = await token.connect(signer).balanceOf(yourAddr);
    document.getElementById('lpYourStrm').innerText = yourStrm / 1e18;
    let yourLP = await pool.connect(signer).balanceOf(yourAddr);
    document.getElementById('lpYourLP').innerText = yourLP / 1e18;
}

provider.on("block", async n => {
    console.log("New block", n)
    await updateIcoPhase();
    await updateStrmAvailable();
    await updateEthFunds();
    await updatePoolReserves();
    await updateYourHoldings();

    if (icoPhase == Phase_OPEN && strmPoolReserve > 0 && ethPoolReserve > 0) {
        currentStrmToEthPrice = await router.connect(signer).quoteSwapSTRMforETH(1000) / 1000.0;
        currentEthToStrmPrice = await router.connect(signer).quoteSwapETHforSTRM(1000) / 1000.0;
        console.log("1 STRM => ", currentStrmToEthPrice, " ETH");
        console.log("1 ETH => ", currentEthToStrmPrice, " STRM");
    }
})

//
// ICO
//
ico_set_general.addEventListener('submit', async e => {
    e.preventDefault();
    await connectToMetamask()
    clearError();
    try {
        (await ico.connect(signer).advancePhase(Phase_GENERAL)).wait();
    } catch (err) {
        displayError(err);
    }
})

ico_set_open.addEventListener('submit', async e => {
    e.preventDefault();
    await connectToMetamask()
    clearError();
    try {
        (await ico.connect(signer).advancePhase(Phase_OPEN)).wait();
    } catch (err) {
        displayError(err);
    }
})

ico_STRM_buy.addEventListener('submit', async e => {
    e.preventDefault()
    const form = e.target
    const eth = ethers.utils.parseEther(form.eth.value)
    console.log("Buying", eth, "eth")

    await connectToMetamask()
    clearError();
    try {
        (await ico.connect(signer).buystrm({ value: eth })).wait();
    } catch (err) {
        displayError(err);
    }
})

ico_withdraw_to_treasury.addEventListener('submit', async e => {
    e.preventDefault()

    await connectToMetamask()
    clearError();
    try {
        const availableFunds = await ico.connect(signer).availableFunds();
        (await ico.connect(signer).withdrawToTreasury(availableFunds)).wait();
    } catch (err) {
        displayError(err);
    }
})


//
// LP
//

lp_deposit.eth.addEventListener('input', e => {
    lp_deposit.strm.value = +e.target.value * currentEthToStrmPrice;
})

lp_deposit.strm.addEventListener('input', e => {
    lp_deposit.eth.value = +e.target.value * currentStrmToEthPrice;
})

lp_deposit.addEventListener('submit', async e => {
    e.preventDefault()
    const form = e.target
    const eth = ethers.utils.parseEther(form.eth.value)
    const strm = ethers.utils.parseEther(form.strm.value)
    console.log("Depositing", eth, "eth and", strm, "strm")

    await connectToMetamask()
    clearError();
    try {
        await token.connect(signer).increaseAllowance(routerAddr, strm);
        await router.connect(signer).addLiquidity(strm, await signer.getAddress(), { value: eth });
    } catch (err) {
        displayError(err);
    }
})

lp_withdraw.addEventListener('submit', async e => {
    e.preventDefault()
    console.log("Withdrawing 100% of LP")

    await connectToMetamask()
    clearError();
    try {
        let signerAddr = await signer.getAddress();
        let lpTokenBalance = await pool.connect(signer).balanceOf(signerAddr);
        await pool.connect(signer).increaseAllowance(routerAddr, lpTokenBalance);
        await router.connect(signer).removeLiquidity(lpTokenBalance, 0, 0, signerAddr);
    } catch (err) {
        displayError(err);
    }
})

//
// Swap
//
let swapIn = { type: 'eth', value: 0 }
let swapOut = { type: 'strm', value: 0 }
switcher.addEventListener('click', () => {
    [swapIn, swapOut] = [swapOut, swapIn]
    swap_in_label.innerText = swapIn.type.toUpperCase()
    swap.amount_in.value = swapIn.value
    updateSwapOutLabel()
})

swap.amount_in.addEventListener('input', updateSwapOutLabel)

function updateSwapOutLabel() {
    swapOut.value = swapIn.type === 'eth' ?
        +swap.amount_in.value * currentEthToStrmPrice :
        +swap.amount_in.value * currentStrmToEthPrice

    swap_out_label.innerText = `${swapOut.value} ${swapOut.type.toUpperCase()}`
}

swap.addEventListener('submit', async e => {
    e.preventDefault()
    const form = e.target
    const amountIn = ethers.utils.parseEther(form.amount_in.value)

    console.log("Swapping", amountIn, swapIn.type, "for", swapOut.type)

    await connectToMetamask()
    clearError();
    try {
        let signerAddr = await signer.getAddress();
        if (swapIn.type === 'eth') {
            await router.connect(signer).swapETHforSTRM(ethers.utils.parseEther("0"), signerAddr, { value: amountIn });
        } else {
            await token.connect(signer).increaseAllowance(routerAddr, amountIn);
            await router.connect(signer).swapSTRMforETH(amountIn, ethers.utils.parseEther("0"), signerAddr);
        }
    } catch (err) {
        displayError(err);
    }
})