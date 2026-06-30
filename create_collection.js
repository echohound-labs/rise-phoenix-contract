const {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  SystemProgram, SYSVAR_RENT_PUBKEY, ComputeBudgetProgram, sendAndConfirmTransaction,
} = require("@solana/web3.js");
const crypto = require("crypto"); const fs = require("fs"); const os = require("os");
const RPC = "https://rpc.mainnet.x1.xyz";
const PROGRAM_ID    = new PublicKey("5QUVVnm1duiRazqa69KW9ZQhCCZcg5GBUKkUn5avA8Gb");
const TOKEN_META    = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM   = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const AUTH_PATH = os.homedir() + "/.config/solana/rise-mint-authority.json";
const URI = process.argv[2] || "https://rise-phoenix-nft.vercel.app/api/metadata/0";
const disc = (n) => crypto.createHash("sha256").update("global:" + n).digest().subarray(0, 8);
const encStr = (s) => { const b = Buffer.from(s, "utf8"); const l = Buffer.alloc(4); l.writeUInt32LE(b.length); return Buffer.concat([l, b]); };
const pda = (seeds, pid) => PublicKey.findProgramAddressSync(seeds, pid)[0];
(async () => {
  const conn = new Connection(RPC, "confirmed");
  const authority = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(AUTH_PATH))));
  const mintState = pda([Buffer.from("mint_state_v2")], PROGRAM_ID);
  const info = await conn.getAccountInfo(mintState);
  if (!info) throw new Error("mint_state PDA not found: " + mintState.toBase58());
  const total = info.data.readUInt32LE(8);
  const stateAuth = new PublicKey(info.data.subarray(12, 44));
  console.log("mint_state PDA   :", mintState.toBase58());
  console.log("total_minted     :", total);
  console.log("mint_state.auth  :", stateAuth.toBase58());
  console.log("our signer       :", authority.publicKey.toBase58());
  if (!stateAuth.equals(authority.publicKey))
    throw new Error("AUTHORITY MISMATCH — create_collection is gated to mint_state.authority " + stateAuth.toBase58() + ". This key can't call it.");
  const collectionMint = Keypair.generate();
  fs.writeFileSync("rise-collection-mint.json", JSON.stringify(Array.from(collectionMint.secretKey)));
  const cm = collectionMint.publicKey;
  const metadata      = pda([Buffer.from("metadata"), TOKEN_META.toBuffer(), cm.toBuffer()], TOKEN_META);
  const masterEdition = pda([Buffer.from("metadata"), TOKEN_META.toBuffer(), cm.toBuffer(), Buffer.from("edition")], TOKEN_META);
  const collectionToken = pda([authority.publicKey.toBuffer(), TOKEN_PROGRAM.toBuffer(), cm.toBuffer()], ATA_PROGRAM);
  const keys = [
    { pubkey: mintState, isSigner: false, isWritable: false },
    { pubkey: authority.publicKey, isSigner: true, isWritable: true },
    { pubkey: cm, isSigner: true, isWritable: true },
    { pubkey: collectionToken, isSigner: false, isWritable: true },
    { pubkey: metadata, isSigner: false, isWritable: true },
    { pubkey: masterEdition, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: ATA_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: TOKEN_META, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
  ];
  const data = Buffer.concat([disc("create_collection"), encStr(URI)]);
  const ix = new TransactionInstruction({ programId: PROGRAM_ID, keys, data });
  console.log("\nCollection mint  :", cm.toBase58(), "(saved to rise-collection-mint.json)");
  console.log("collection uri   :", URI);
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 })).add(ix);
  const sig = await sendAndConfirmTransaction(conn, tx, [authority, collectionMint], { commitment: "confirmed" });
  console.log("\n✅ create_collection landed:", sig);
  console.log("➡  COLLECTION MINT (save this!):", cm.toBase58());
})().catch((e) => { console.error("\n❌ FAILED:", e.message || e); process.exit(1); });
