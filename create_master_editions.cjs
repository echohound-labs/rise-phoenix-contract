const {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  ComputeBudgetProgram, sendAndConfirmTransaction,
} = require("@solana/web3.js");
const crypto = require("crypto"); const fs = require("fs"); const os = require("os");
const RPC = "https://rpc.mainnet.x1.xyz";
const PROGRAM_ID = new PublicKey("5QUVVnm1duiRazqa69KW9ZQhCCZcg5GBUKkUn5avA8Gb");
const TOKEN_META = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const SYS = new PublicKey("11111111111111111111111111111111");
const RENT = new PublicKey("SysvarRent111111111111111111111111111111111");
const AUTH_PATH = os.homedir() + "/.config/solana/rise-mint-authority.json";
const disc = (n) => crypto.createHash("sha256").update("global:" + n).digest().subarray(0, 8);
const pda = (s, p) => PublicKey.findProgramAddressSync(s, p)[0];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const N = (process.argv[2] === "all") ? Infinity : parseInt(process.argv[2] || "1", 10);
  const conn = new Connection(RPC, "confirmed");
  const authority = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(AUTH_PATH))));
  const mintState = pda([Buffer.from("mint_state_v2")], PROGRAM_ID);
  console.log("authority :", authority.publicKey.toBase58());
  console.log("enumerating members…");
  const accts = await conn.getProgramAccounts(TOKEN_META, {
    filters: [{ memcmp: { offset: 1, bytes: mintState.toBase58() } }]
  });
  console.log(`found ${accts.length} metadata accounts (incl. parent)`);

  console.log("checking which already have a master edition…");
  const pending = [];
  let have = 0;
  for (const a of accts) {
    const mint = new PublicKey(a.account.data.slice(33, 65));
    const me = pda([Buffer.from("metadata"), TOKEN_META.toBuffer(), mint.toBuffer(), Buffer.from("edition")], TOKEN_META);
    const meAcc = await conn.getAccountInfo(me);
    if (meAcc) { have++; }
    else pending.push({ metadata: a.pubkey, mint, me });
    await sleep(60);
  }
  console.log(`already have master edition : ${have}  (parent + pilot expected)`);
  console.log(`pending                     : ${pending.length}  (this run does up to ${N === Infinity ? "ALL" : N})`);

  let done = 0, fail = 0;
  for (const it of pending) {
    if (done >= N) break;
    try {
      const keys = [
        { pubkey: mintState,           isSigner: false, isWritable: false },
        { pubkey: authority.publicKey, isSigner: true,  isWritable: true  },
        { pubkey: it.metadata,         isSigner: false, isWritable: true  },
        { pubkey: it.mint,             isSigner: false, isWritable: true  },
        { pubkey: it.me,               isSigner: false, isWritable: true  },
        { pubkey: TOKEN_META,          isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM,       isSigner: false, isWritable: false },
        { pubkey: SYS,                 isSigner: false, isWritable: false },
        { pubkey: RENT,                isSigner: false, isWritable: false },
      ];
      const ix = new TransactionInstruction({ programId: PROGRAM_ID, keys, data: disc("create_member_master_edition") });
      const tx = new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }))
        .add(ix);
      const sig = await sendAndConfirmTransaction(conn, tx, [authority], { commitment: "confirmed" });
      done++;
      console.log(`[${done}/${pending.length}] ${it.mint.toBase58()} ✓ ${sig.slice(0, 16)}…`);
      await sleep(250);
    } catch (e) {
      fail++;
      console.error(`FAIL ${it.mint.toBase58()}: ${(e.message || "").slice(0, 120)}`);
      await sleep(600);
    }
  }
  console.log(`run complete — ${done} done, ${fail} failed, ${pending.length - done - fail} remaining`);
})();
