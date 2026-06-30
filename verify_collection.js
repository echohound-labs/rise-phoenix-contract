const {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  ComputeBudgetProgram, sendAndConfirmTransaction,
} = require("@solana/web3.js");
const crypto = require("crypto"); const fs = require("fs"); const os = require("os");
const RPC = "https://rpc.mainnet.x1.xyz";
const PROGRAM_ID = new PublicKey("5QUVVnm1duiRazqa69KW9ZQhCCZcg5GBUKkUn5avA8Gb");
const TOKEN_META = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const AUTH_PATH  = os.homedir() + "/.config/solana/rise-mint-authority.json";
const COLL_PATH  = "rise-collection-mint.json";
const disc = (n) => crypto.createHash("sha256").update("global:" + n).digest().subarray(0, 8);
const pda  = (s, p) => PublicKey.findProgramAddressSync(s, p)[0];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function isVerifiedInto(data, collBuf) {
  try {
    let o = 1 + 32 + 32;
    const skipStr = () => { const l = data.readUInt32LE(o); o += 4 + l; };
    skipStr(); skipStr(); skipStr();
    o += 2;
    if (data.readUInt8(o++) === 1) { const n = data.readUInt32LE(o); o += 4 + n * 34; }
    o += 1; o += 1;
    if (data.readUInt8(o++) === 1) o += 1;
    if (data.readUInt8(o++) === 1) o += 1;
    if (data.readUInt8(o++) !== 1) return false;
    const verified = data.readUInt8(o) === 1; o += 1;
    return verified && data.subarray(o, o + 32).equals(collBuf);
  } catch { return false; }
}
(async () => {
  const N = (process.argv[2] === "all") ? Infinity : parseInt(process.argv[2] || "1", 10);
  const conn = new Connection(RPC, "confirmed");
  const authority = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(AUTH_PATH))));
  const collMint  = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(COLL_PATH)))).publicKey;
  const mintState        = pda([Buffer.from("mint_state_v2")], PROGRAM_ID);
  const collMetadata     = pda([Buffer.from("metadata"), TOKEN_META.toBuffer(), collMint.toBuffer()], TOKEN_META);
  const collMasterEdition= pda([Buffer.from("metadata"), TOKEN_META.toBuffer(), collMint.toBuffer(), Buffer.from("edition")], TOKEN_META);
  console.log("collection mint  :", collMint.toBase58());
  console.log("enumerating members…");
  const accts = await conn.getProgramAccounts(TOKEN_META, { filters: [{ memcmp: { offset: 1, bytes: mintState.toBase58() } }] });
  const members = accts.filter(a => !a.pubkey.equals(collMetadata));
  console.log(`found ${members.length} member metadata accounts (excluded parent).`);
  const collBuf = collMint.toBuffer();
  const pending = members.filter(a => !isVerifiedInto(a.account.data, collBuf));
  console.log(`already verified : ${members.length - pending.length}`);
  console.log(`to verify        : ${pending.length}  (this run does up to ${N === Infinity ? "ALL" : N})`);
  let done = 0, fail = 0;
  for (const a of pending) {
    if (done >= N) break;
    const metadata = a.pubkey;
    const keys = [
      { pubkey: mintState, isSigner: false, isWritable: false },
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: metadata, isSigner: false, isWritable: true },
      { pubkey: collMint, isSigner: false, isWritable: false },
      { pubkey: collMetadata, isSigner: false, isWritable: true },
      { pubkey: collMasterEdition, isSigner: false, isWritable: false },
      { pubkey: TOKEN_META, isSigner: false, isWritable: false },
    ];
    const ix = new TransactionInstruction({ programId: PROGRAM_ID, keys, data: disc("verify_collection") });
    const tx = new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }))
      .add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50000 }))
      .add(ix);
    let ok = false, lastErr;
    for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
      try {
        const sig = await sendAndConfirmTransaction(conn, tx, [authority], { commitment: "confirmed" });
        const after = await conn.getAccountInfo(metadata);
        console.log(`✅ ${metadata.toBase58()}  verified=${isVerifiedInto(after.data, collBuf)}  ${sig.slice(0,16)}…`);
        ok = true; done++;
      } catch (e) { lastErr = e.message || String(e); await sleep(1500 * attempt); }
    }
    if (!ok) { console.log(`❌ ${metadata.toBase58()}  ${lastErr}`); fail++; }
    await sleep(400);
  }
  console.log(`\nrun complete — verified ${done}, failed ${fail}, remaining ${pending.length - done - fail}`);
})().catch(e => { console.error("\n❌ FATAL:", e.message || e); process.exit(1); });
