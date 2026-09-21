// Set royalty + creators on all RISE Phoenix NFTs via the program's
// authority-gated `update_royalty`, then verify the creator with Metaplex
// SignMetadata. Ported from cappy-nft-mint's update_royalty.cjs.
//
//   node update_royalty.cjs                          dry-run, mainnet, all members
//   node update_royalty.cjs --cluster testnet        dry-run against testnet
//   node update_royalty.cjs --mint <MINT>            single NFT
//   node update_royalty.cjs --send                   actually send (testnet)
//   node update_royalty.cjs --send --confirm-mainnet actually send (mainnet)
//
// Other flags: --limit N, --program <ID>, --creator <PUBKEY>,
//              --authority-keypair <path>, --creator-keypair <path>
//
// Dry-run is the default and never reads a keypair file. NFTs already at the
// target state are skipped, so reruns only touch what is left.
//
// The 217 minted members are currently in three states, all converging to the
// target [treasury:100 verified] @ 100bps:
//   80  mint_state PDA  as VERIFIED creator   (dropped; PDA == update authority)
//   75  BAMEPcc wallet  as unverified creator (replaced)
//   62  treasury Gowv…  as unverified creator (kept, then verified)
// The parent collection NFT (no "#N" in its name) is intentionally left alone.
const { Connection, PublicKey, Keypair, Transaction, TransactionInstruction, ComputeBudgetProgram, sendAndConfirmTransaction } = require("@solana/web3.js");
const crypto = require("crypto"), fs = require("fs");

const CLUSTERS = {
  mainnet: { rpc: "https://rpc.mainnet.x1.xyz", program: "5QUVVnm1duiRazqa69KW9ZQhCCZcg5GBUKkUn5avA8Gb" },
  testnet: { rpc: "https://rpc.testnet.x1.xyz", program: "5QUVVnm1duiRazqa69KW9ZQhCCZcg5GBUKkUn5avA8Gb" },
};
const MPL = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

// ── Target state ───────────────────────────────────────────────────────
const TARGET_BPS = 100; // 1%
const DEFAULT_CREATOR = "Gowv5PDb7K4a5PwjubWegvBT4CDfjjJcG4QAZWa9yUob"; // rise-treasury

// ── Args ───────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const SEND = flag("--send");
const clusterName = opt("--cluster", "mainnet");
const cluster = CLUSTERS[clusterName];
if (!cluster) { console.error("unknown --cluster", clusterName); process.exit(1); }
const PROGRAM = new PublicKey(opt("--program", cluster.program));
const CREATOR = new PublicKey(opt("--creator", DEFAULT_CREATOR));
const ONLY_MINT = opt("--mint", null);
const LIMIT = +opt("--limit", 0);
const AUTH_KP = opt("--authority-keypair", process.env.HOME + "/.config/solana/rise-mint-authority.json");
const CREATOR_KP = opt("--creator-keypair", process.env.HOME + "/.config/solana/rise-treasury.json");
const CONCURRENCY = 4;

const [MINT_STATE] = PublicKey.findProgramAddressSync([Buffer.from("mint_state_v2")], PROGRAM);
const mdPda = (mint) => PublicKey.findProgramAddressSync([Buffer.from("metadata"), MPL.toBuffer(), mint.toBuffer()], MPL)[0];

function parseMetadata(d) {
  let o = 1;
  const ua = new PublicKey(d.slice(o, o + 32)); o += 32;
  const mint = new PublicKey(d.slice(o, o + 32)); o += 32;
  const str = () => { const n = d.readUInt32LE(o); o += 4; const s = d.slice(o, o + n).toString("utf8").replace(/\0/g, ""); o += n; return s; };
  const name = str(), symbol = str(), uri = str();
  const fee = d.readUInt16LE(o); o += 2;
  const creators = [];
  if (d[o++] === 1) {
    const n = d.readUInt32LE(o); o += 4;
    for (let i = 0; i < n; i++) { creators.push({ address: new PublicKey(d.slice(o, o + 32)).toBase58(), verified: d[o + 32] === 1, share: d[o + 33] }); o += 34; }
  }
  return { ua, mint, name, symbol, uri, fee, creators };
}

// What does this NFT still need? update = fee/creator list wrong; verify = creator not yet signed.
function plan(m) {
  const c = m.creators;
  const listOk = c.length === 1 && c[0].address === CREATOR.toBase58() && c[0].share === 100;
  const update = m.fee !== TARGET_BPS || !listOk;
  const verify = update ? true : !c[0].verified;
  return { update, verify };
}

function updateRoyaltyIx(authority, metadata) {
  const disc = crypto.createHash("sha256").update("global:update_royalty").digest().slice(0, 8);
  const bps = Buffer.alloc(2); bps.writeUInt16LE(TARGET_BPS);
  const len = Buffer.alloc(4); len.writeUInt32LE(1);
  const data = Buffer.concat([disc, bps, len, CREATOR.toBuffer(), Buffer.from([100])]);
  return new TransactionInstruction({
    programId: PROGRAM,
    keys: [
      { pubkey: MINT_STATE, isSigner: false, isWritable: false },
      { pubkey: authority,  isSigner: true,  isWritable: false },
      { pubkey: metadata,   isSigner: false, isWritable: true  },
      { pubkey: MPL,        isSigner: false, isWritable: false },
    ],
    data,
  });
}

// Metaplex SignMetadata (instruction 7): creator signs to flip its own verified flag.
const signMetadataIx = (metadata) => new TransactionInstruction({
  programId: MPL,
  keys: [
    { pubkey: metadata, isSigner: false, isWritable: true },
    { pubkey: CREATOR,  isSigner: true,  isWritable: false },
  ],
  data: Buffer.from([7]),
});

function buildTx(authority, m, p) {
  const md = mdPda(m.mint);
  const tx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000_000 }))
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
  if (p.update) tx.add(updateRoyaltyIx(authority, md));
  if (p.verify) tx.add(signMetadataIx(md));
  tx.feePayer = authority;
  return tx;
}

const fmt = (m) => `${m.fee}bps ` + (m.creators.map(c => `${c.address.slice(0, 4)}…${c.address.slice(-4)}:${c.share}${c.verified ? "✓" : "✗"}`).join(",") || "no-creators");
const num = (m) => +(m.name.match(/#(\d+)/) || [0, 0])[1];

(async () => {
  const c = new Connection(cluster.rpc, "confirmed");
  console.log(`cluster   : ${clusterName} (${cluster.rpc})`);
  console.log(`program   : ${PROGRAM.toBase58()}`);
  console.log(`mint_state: ${MINT_STATE.toBase58()}`);
  console.log(`target    : ${TARGET_BPS}bps, creator ${CREATOR.toBase58()} share 100, verified`);
  console.log(`mode      : ${SEND ? "SEND" : "DRY-RUN (nothing is signed or sent)"}\n`);

  const ms = await c.getAccountInfo(MINT_STATE);
  if (!ms) throw new Error("mint_state account not found on this cluster");
  const authority = new PublicKey(ms.data.slice(12, 44));
  console.log(`authority : ${authority.toBase58()} (from mint_state)`);

  // ── Discover ─────────────────────────────────────────────────────────
  let items;
  if (ONLY_MINT) {
    const acc = await c.getAccountInfo(mdPda(new PublicKey(ONLY_MINT)));
    if (!acc) throw new Error("no metadata account for mint " + ONLY_MINT);
    items = [parseMetadata(acc.data)];
  } else {
    const accs = await c.getProgramAccounts(MPL, { filters: [{ memcmp: { offset: 1, bytes: MINT_STATE.toBase58() } }] });
    // members only — the collection NFT has no "#N" in its name and is left alone
    items = accs.map(a => parseMetadata(a.account.data)).filter(m => /#\d+/.test(m.name)).sort((a, b) => num(a) - num(b));
  }
  for (const m of items) if (!m.ua.equals(MINT_STATE)) throw new Error(`${m.mint.toBase58()}: update authority is ${m.ua.toBase58()}, not mint_state`);

  // ── Diff ─────────────────────────────────────────────────────────────
  const targetStr = `${TARGET_BPS}bps ${CREATOR.toBase58().slice(0, 4)}…${CREATOR.toBase58().slice(-4)}:100✓`;
  let pending = [];
  for (const m of items) {
    const p = plan(m);
    const action = p.update ? "UPDATE+VERIFY" : p.verify ? "VERIFY" : "ok (skip)";
    console.log(`${m.name.padEnd(22)} ${m.mint.toBase58().padEnd(44)} ${fmt(m).padEnd(28)} -> ${targetStr}  ${action}`);
    if (p.update || p.verify) pending.push({ m, p });
  }
  console.log(`\n${items.length} NFTs: ${items.length - pending.length} already correct, ${pending.length} to change`);
  if (LIMIT && pending.length > LIMIT) { pending = pending.slice(0, LIMIT); console.log(`--limit ${LIMIT}: only processing the first ${LIMIT}`); }
  if (!pending.length) return;

  if (!SEND) {
    // Read-only simulation of the first pending tx: shows whether the deployed
    // program has update_royalty yet. No signatures involved.
    const { m, p } = pending[0];
    const tx = buildTx(authority, m, p);
    tx.recentBlockhash = (await c.getLatestBlockhash()).blockhash;
    const sim = await c.simulateTransaction(tx);
    console.log(`\nsimulation of ${m.name}: ${sim.value.err ? "FAILS " + JSON.stringify(sim.value.err) : "ok"}`);
    if (sim.value.err) {
      (sim.value.logs || []).slice(-6).forEach(l => console.log("   " + l));
      console.log("   (InstructionFallbackNotFound / 0x65 = the deployed program does not have update_royalty yet)");
    }
    console.log("\nDry-run only. Re-run with --send to apply.");
    return;
  }

  // ── Send ─────────────────────────────────────────────────────────────
  if (clusterName === "mainnet" && !flag("--confirm-mainnet")) throw new Error("refusing to send on mainnet without --confirm-mainnet");
  const load = (f) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(f))));
  const authKp = load(AUTH_KP), creatorKp = load(CREATOR_KP);
  if (!authKp.publicKey.equals(authority)) throw new Error(`${AUTH_KP} is ${authKp.publicKey.toBase58()}, not mint_state.authority`);
  if (!creatorKp.publicKey.equals(CREATOR)) throw new Error(`${CREATOR_KP} is ${creatorKp.publicKey.toBase58()}, not the target creator`);

  let ok = 0, failed = 0;
  const one = async ({ m, p }) => {
    try {
      const sig = await sendAndConfirmTransaction(c, buildTx(authority, m, p), [authKp, creatorKp], { commitment: "confirmed" });
      // read back and check before counting it done
      const after = parseMetadata((await c.getAccountInfo(mdPda(m.mint), "confirmed")).data);
      const q = plan(after);
      if (q.update || q.verify) throw new Error("post-check mismatch: " + fmt(after));
      ok++; console.log(`OK   ${m.name.padEnd(22)} ${sig}`);
    } catch (e) { failed++; console.log(`FAIL ${m.name.padEnd(22)} ${m.mint.toBase58()} ${e.message.split("\n")[0]}`); }
  };
  for (let i = 0; i < pending.length; i += CONCURRENCY) await Promise.all(pending.slice(i, i + CONCURRENCY).map(one));
  console.log(`\ndone: ${ok} updated, ${failed} failed${failed ? " — rerun to retry (finished NFTs are skipped)" : ""}`);
  if (failed) process.exit(1);
})().catch(e => { console.error("ERR", e.message); process.exit(1); });
