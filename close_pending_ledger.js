const { Connection, PublicKey, Transaction, TransactionInstruction } = require("@solana/web3.js");
const Transport = require("@ledgerhq/hw-transport-node-hid").default;
const Solana = require("@ledgerhq/hw-app-solana").default;
(async () => {
  const RISE = new PublicKey("5QUVVnm1duiRazqa69KW9ZQhCCZcg5GBUKkUn5avA8Gb");
  const minter = new PublicKey("4jLcjZLcDcGuS1M4SHtBRPXs2h3HULUL2fDnCuaaLzzY");
  const path = "44'/501'/0'/0'";
  const conn = new Connection("https://rpc.mainnet.x1.xyz", "confirmed");
  const [pending] = PublicKey.findProgramAddressSync([Buffer.from("pending_mint"), minter.toBuffer()], RISE);
  const ix = new TransactionInstruction({ programId: RISE, keys: [
    { pubkey: pending, isSigner: false, isWritable: true },
    { pubkey: minter, isSigner: true, isWritable: true },
  ], data: Buffer.from("80c9134ef9e70aa5", "hex") });
  const tx = new Transaction().add(ix);
  tx.feePayer = minter;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  const msg = tx.serializeMessage();
  const t = await Transport.open(""); const sol = new Solana(t);
  console.log("→ confirm on your Ledger…");
  const { signature } = await sol.signTransaction(path, msg);
  tx.addSignature(minter, signature);
  const sig = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction(sig, "confirmed");
  console.log("✅ closed pending_mint:", sig);
})().catch(e => { console.error("❌", e.message || e); process.exit(1); });
