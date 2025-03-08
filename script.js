const { 
    Connection, 
    PublicKey, 
    Keypair, 
    LAMPORTS_PER_SOL,
    Transaction,
    VersionedTransaction,
    sendAndConfirmTransaction
} = require('@solana/web3.js');
const { 
    getAssociatedTokenAddress, 
    createAssociatedTokenAccountInstruction,
    withdrawWithheldTokensFromAccounts,
    unpackAccount,
    getTransferFeeAmount,
    TOKEN_PROGRAM_ID,
    createTransferCheckedInstruction
} = require('@solana/spl-token');
const axios = require('axios');
const schedule = require('node-schedule');
const fs = require('fs');

// Constants
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const MINT_ADDRESS = new PublicKey('SLERF');
const AUTHORITY_ADDRESS = new PublicKey('DEPLOYER');
const DEPLOYER_ATA = new PublicKey('vn1AZWEcKkyFQjDGs1M3f8MPwjpdtZAUt8aRijH5jPZ');
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const RAYDIUM_POOL_OWNER = new PublicKey('5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1');
const RAYDIUM_POOL_ATA = new PublicKey('4XxuTr8qRZn7ocuKiPQ1cWjjdZ1gWyXDscF5ztiUDnDE');
const JUPITER_API = 'https://quote-api.jup.ag/v6';
const MIN_SWAP_AMOUNT = 100000; // 0.1 tokens (6 decimals)
const USDC_DECIMALS = 6;
const CYCLE_TIMEOUT_MS = 300000; // 5 minutes
const RPC_TIMEOUT_MS = 60000; // 60 seconds
const MIN_SOL_BALANCE = 0.05;
const MAX_CONSECUTIVE_FAILURES = 5;
const BATCH_SIZE = 1000; // Holders batch size
const SWAP_BATCH_THRESHOLD = 1000000000; // 1,000 USDC worth of tokens (assuming 6 decimals)
const SWAP_BATCH_SIZE = 500000000; // 500 USDC worth per batch (adjust based on token price)
const SWAP_DELAY_MS = 10000; // 10 seconds between swaps

let payer;
try {
    const keypairData = JSON.parse(fs.readFileSync('C:\Users\jungh\Desktop\PPP-coin\DeployerJson\new_wallet.json', 'utf-8'));
    payer = Keypair.fromSecretKey(new Uint8Array(keypairData));
    console.log(`Loaded keypair: ${payer.publicKey.toString()}`);
    if (payer.publicKey.toString() !== AUTHORITY_ADDRESS.toString()) {
        throw new Error('Loaded keypair does not match the authority address!');
    }
} catch (err) {
    console.error('Failed to load new_wallet.json or keypair mismatch:', err.message);
    process.exit(1);
}

const primaryConnection = new Connection('https://dimensional-practical-wind.solana-mainnet.quiknode.pro/3f8eb17225aef200667c3b8562fbf9f714d458d8/', 'confirmed');
const fallbackConnection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
let connection = primaryConnection;
let rpcCooldown = 0;

async function retryRpcCall(fn, maxRetries = 5, baseDelayMs = 1000) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await Promise.race([
                fn(),
                new Promise((_, reject) => setTimeout(() => reject(new Error(`RPC timeout after ${RPC_TIMEOUT_MS / 1000}s`)), RPC_TIMEOUT_MS))
            ]);
        } catch (err) {
            console.error(`RPC attempt ${attempt}/${maxRetries} failed: ${err.message}`);
            if (attempt === maxRetries) {
                if (err.message.includes('410 Gone')) {
                    console.warn('RPC method disabled, falling back to cache...');
                    return null;
                }
                console.warn('Switching RPC...');
                connection = connection === primaryConnection ? fallbackConnection : primaryConnection;
                rpcCooldown = Date.now() + 300000;
                throw err;
            }
            const delay = baseDelayMs * Math.pow(2, attempt - 1);
            console.log(`Retrying in ${delay}ms`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

async function checkRpcHealth() {
    if (rpcCooldown && Date.now() > rpcCooldown) {
        console.log('Cooldown expired, reverting to primary RPC...');
        connection = primaryConnection;
        rpcCooldown = 0;
    }
    try {
        await connection.getSlot('confirmed', { timeout: 5000 });
        return true;
    } catch {
        console.warn('RPC unhealthy, switching...');
        connection = connection === primaryConnection ? fallbackConnection : primaryConnection;
        return false;
    }
}

async function checkSolBalance(minSol = MIN_SOL_BALANCE) {
    const balance = await retryRpcCall(() => connection.getBalance(payer.publicKey));
    if (balance === null) throw new Error('Failed to fetch SOL balance');
    if (balance < minSol * LAMPORTS_PER_SOL) {
        throw new Error(`SOL balance too low: ${balance / LAMPORTS_PER_SOL} SOL < ${minSol} SOL`);
    }
    console.log(`SOL balance: ${balance / LAMPORTS_PER_SOL} SOL`);
    return balance;
}

async function collectWithheldTokens(destinationAccount) {
    console.log('Fetching token accounts...');
    const allAccounts = await retryRpcCall(() =>
        connection.getProgramAccounts(TOKEN_2022_PROGRAM_ID, {
            commitment: 'confirmed',
            filters: [{ memcmp: { offset: 0, bytes: MINT_ADDRESS.toBase58() } }]
        })
    );
    if (!allAccounts) return 0;
    console.log(`Found ${allAccounts.length} token accounts`);

    const accountsToWithdrawFrom = [];
    let totalWithheld = 0n;
    for (const accountInfo of allAccounts) {
        const account = unpackAccount(accountInfo.pubkey, accountInfo.account, TOKEN_2022_PROGRAM_ID);
        const transferFeeAmount = getTransferFeeAmount(account);
        if (transferFeeAmount?.withheldAmount > 0n) {
            accountsToWithdrawFrom.push(accountInfo.pubkey);
            totalWithheld += transferFeeAmount.withheldAmount;
        }
    }
    console.log(`Found ${accountsToWithdrawFrom.length} accounts with ${Number(totalWithheld) / 1e6} withheld tokens`);

    if (accountsToWithdrawFrom.length === 0) return 0;

    const signature = await withdrawWithheldTokensFromAccounts(
        connection,
        payer,
        MINT_ADDRESS,
        destinationAccount,
        AUTHORITY_ADDRESS,
        [],
        accountsToWithdrawFrom,
        undefined,
        TOKEN_2022_PROGRAM_ID
    );
    console.log(`Collected ${Number(totalWithheld) / 1e6} tokens. Signature: ${signature}`);
    return Number(totalWithheld);
}

async function swapToUSDC(amount) {
    await checkSolBalance();
    if (amount < MIN_SWAP_AMOUNT) {
        console.log(`Amount ${amount / 1e6} below threshold (${MIN_SWAP_AMOUNT / 1e6}); skipping swap.`);
        return 0;
    }

    const usdcAccount = await getAssociatedTokenAddress(USDC_MINT, AUTHORITY_ADDRESS);
    let totalUsdc = 0;

    // Estimate USDC value (rough approximation, adjust based on actual token price)
    const quoteResponse = await axios.get(`${JUPITER_API}/quote`, {
        params: {
            inputMint: MINT_ADDRESS.toString(),
            outputMint: USDC_MINT.toString(),
            amount: amount.toString(),
            slippageBps: 100
        }
    });
    const estimatedUsdc = Number(quoteResponse.data.outAmount);

    if (estimatedUsdc > SWAP_BATCH_THRESHOLD) {
        console.log(`Large swap detected (${estimatedUsdc / 1e6} USDC), splitting into batches...`);
        const batchSize = SWAP_BATCH_SIZE; // Tokens per batch
        const numBatches = Math.ceil(amount / batchSize);
        for (let i = 0; i < numBatches; i++) {
            const batchAmount = Math.min(batchSize, amount - (i * batchSize));
            console.log(`Swapping batch ${i + 1}/${numBatches}: ${batchAmount / 1e6} tokens...`);

            const batchQuote = await axios.get(`${JUPITER_API}/quote`, {
                params: {
                    inputMint: MINT_ADDRESS.toString(),
                    outputMint: USDC_MINT.toString(),
                    amount: batchAmount.toString(),
                    slippageBps: 100
                }
            });

            const swapResponse = await axios.post(`${JUPITER_API}/swap`, {
                quoteResponse: batchQuote.data,
                userPublicKey: payer.publicKey.toString(),
                wrapAndUnwrapSol: true,
                destinationTokenAccount: usdcAccount.toString(),
                dynamicComputeUnitLimit: true
            });
            const { swapTransaction } = swapResponse.data;

            const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
            const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
            const { blockhash, lastValidBlockHeight } = await retryRpcCall(() => connection.getLatestBlockhash('confirmed'));
            if (!blockhash) throw new Error('Failed to fetch blockhash');
            transaction.message.recentBlockhash = blockhash;
            transaction.sign([payer]);

            const signature = await connection.sendTransaction(transaction, {
                skipPreflight: false,
                preflightCommitment: 'confirmed'
            });
            await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
            console.log(`Batch ${i + 1} swapped. Signature: ${signature}`);

            const usdcBalance = await retryRpcCall(() => connection.getTokenAccountBalance(usdcAccount));
            if (!usdcBalance) throw new Error('Failed to fetch USDC balance');
            totalUsdc += Number(usdcBalance.value.amount) - totalUsdc; // Incremental increase
            await new Promise(resolve => setTimeout(resolve, SWAP_DELAY_MS));
        }
    } else {
        console.log(`Swapping ${amount / 1e6} tokens to USDC in one transaction...`);
        const swapResponse = await axios.post(`${JUPITER_API}/swap`, {
            quoteResponse: quoteResponse.data,
            userPublicKey: payer.publicKey.toString(),
            wrapAndUnwrapSol: true,
            destinationTokenAccount: usdcAccount.toString(),
            dynamicComputeUnitLimit: true
        });
        const { swapTransaction } = swapResponse.data;

        const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
        const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
        const { blockhash, lastValidBlockHeight } = await retryRpcCall(() => connection.getLatestBlockhash('confirmed'));
        if (!blockhash) throw new Error('Failed to fetch blockhash');
        transaction.message.recentBlockhash = blockhash;
        transaction.sign([payer]);

        const signature = await connection.sendTransaction(transaction, {
            skipPreflight: false,
            preflightCommitment: 'confirmed'
        });
        await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
        console.log(`Swapped to USDC. Signature: ${signature}`);

        const usdcBalance = await retryRpcCall(() => connection.getTokenAccountBalance(usdcAccount));
        if (!usdcBalance) throw new Error('Failed to fetch USDC balance');
        totalUsdc = Number(usdcBalance.value.amount);
    }

    console.log(`Total USDC swapped: ${totalUsdc / 1e6} USDC`);
    return totalUsdc;
}

async function getHolders() {
    const cacheFile = 'holders.json';
    let holders = [];
    let totalSupply = 0;

    if (fs.existsSync(cacheFile)) {
        const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
        holders = cached.holders.map(h => ({ ...h, owner: new PublicKey(h.owner) }));
        totalSupply = cached.totalSupply;
        console.log(`Loaded ${holders.length} holders from cache`);
    }

    const lastUpdated = fs.existsSync(cacheFile) ? fs.statSync(cacheFile).mtimeMs : 0;
    if (Date.now() - lastUpdated > 24 * 60 * 60 * 1000) {
        console.log('Refreshing holder data...');
        const allAccounts = await retryRpcCall(() => 
            connection.getProgramAccounts(TOKEN_2022_PROGRAM_ID, {
                commitment: 'confirmed',
                filters: [{ memcmp: { offset: 0, bytes: MINT_ADDRESS.toBase58() } }]
            })
        );
        if (allAccounts) {
            holders = [];
            totalSupply = 0;
            for (const accountInfo of allAccounts) {
                const account = unpackAccount(accountInfo.pubkey, accountInfo.account, TOKEN_2022_PROGRAM_ID);
                const amount = Number(account.amount);
                const ownerStr = account.owner.toString();
                const accountStr = accountInfo.pubkey.toString();
                if (amount > 0 && 
                    ownerStr !== AUTHORITY_ADDRESS.toString() && 
                    accountStr !== DEPLOYER_ATA.toString() && 
                    ownerStr !== RAYDIUM_POOL_OWNER.toString() && 
                    accountStr !== RAYDIUM_POOL_ATA.toString()) {
                    holders.push({ address: accountInfo.pubkey, owner: account.owner, amount });
                    totalSupply += amount;
                }
            }
            console.log(`Fetched ${holders.length} holders with ${totalSupply / 1e6} tokens`);
            fs.writeFileSync(cacheFile, JSON.stringify({ holders: holders.map(h => ({ ...h, owner: h.owner.toString() })), totalSupply }), 'utf-8');
        } else {
            console.log('Using cached holders due to RPC failure');
        }
    }

    return { holders, totalSupply };
}

async function distributeUSDC(usdcAmount) {
    await checkSolBalance();
    const { holders, totalSupply } = await getHolders();
    if (holders.length === 0 || totalSupply === 0) {
        console.log('No valid holders found.');
        return;
    }

    console.log(`Distributing ${usdcAmount / 1e6} USDC to ${holders.length} holders...`);
    const usdcAccount = await getAssociatedTokenAddress(USDC_MINT, AUTHORITY_ADDRESS);

    for (let i = 0; i < holders.length; i += BATCH_SIZE) {
        const chunk = holders.slice(i, i + BATCH_SIZE);
        const transaction = new Transaction();
        let distributedTotal = 0;

        for (const holder of chunk) {
            const proportion = holder.amount / totalSupply;
            const holderAmount = Math.floor(usdcAmount * proportion);
            if (holderAmount > 0) {
                const holderUSDCAccount = await getAssociatedTokenAddress(USDC_MINT, holder.owner);
                const accountInfo = await retryRpcCall(() => connection.getAccountInfo(holderUSDCAccount));
                if (accountInfo === null) {
                    console.log(`Creating ATA for ${holder.owner.toString()}`);
                    transaction.add(
                        createAssociatedTokenAccountInstruction(
                            payer.publicKey,
                            holderUSDCAccount,
                            holder.owner,
                            USDC_MINT,
                            TOKEN_PROGRAM_ID
                        )
                    );
                } else if (!accountInfo) {
                    console.log(`Skipping ${holder.owner.toString()} due to RPC failure`);
                    continue;
                }
                transaction.add(
                    createTransferCheckedInstruction(
                        usdcAccount,
                        USDC_MINT,
                        holderUSDCAccount,
                        AUTHORITY_ADDRESS,
                        holderAmount,
                        USDC_DECIMALS
                    )
                );
                distributedTotal += holderAmount;
            }
        }

        if (transaction.instructions.length > 0) {
            const { blockhash, lastValidBlockHeight } = await retryRpcCall(() => connection.getLatestBlockhash('confirmed'));
            if (!blockhash) throw new Error('Failed to fetch blockhash');
            transaction.recentBlockhash = blockhash;
            transaction.feePayer = payer.publicKey;
            const signature = await sendAndConfirmTransaction(connection, transaction, [payer], { commitment: 'confirmed' });
            console.log(`Distributed ${distributedTotal / 1e6} USDC to ${chunk.length} holders. Signature: ${signature}`);
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
}

async function automateProcess() {
    console.log(`Cycle started at ${new Date().toISOString()}`);
    try {
        await checkRpcHealth();
        await checkSolBalance();
        const destinationAccount = await getAssociatedTokenAddress(MINT_ADDRESS, AUTHORITY_ADDRESS, false, TOKEN_2022_PROGRAM_ID);
        const collectedAmount = await collectWithheldTokens(destinationAccount);
        if (collectedAmount > 0) {
            const usdcAmount = await swapToUSDC(collectedAmount);
            if (usdcAmount > 0) {
                await distributeUSDC(usdcAmount);
            }
        }
        console.log(`Cycle completed at ${new Date().toISOString()}`);
    } catch (err) {
        console.error(`Cycle failed: ${err.message}`, err.stack);
        throw err;
    }
}

let isRunning = false;
let consecutiveFailures = 0;

function runAutomation() {
    console.log('Starting automation at', new Date().toISOString());
    automateProcess().catch(err => console.error('Initial run failed:', err.message));

    const job = schedule.scheduleJob('*/5 * * * *', async () => {
        if (isRunning) {
            console.log('Skipping cycle; previous run in progress');
            return;
        }
        isRunning = true;
        try {
            await automateProcess();
            consecutiveFailures = 0;
        } catch (err) {
            consecutiveFailures++;
            console.error(`Failure ${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}`);
            if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                console.error('Too many failures, restarting in 10 seconds...');
                setTimeout(() => {
                    consecutiveFailures = 0;
                    runAutomation();
                }, 10000);
                return;
            }
        } finally {
            isRunning = false;
        }
    });
    console.log('Scheduler started, next run at:', job.nextInvocation().toISOString());
}

// Global error handlers
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err.message, err.stack);
    isRunning = false;
    setTimeout(runAutomation, 10000);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection:', reason instanceof Error ? reason.stack : reason);
    isRunning = false;
    setTimeout(runAutomation, 10000);
});

// Start the automation
runAutomation();
console.log('Automation setup complete');