// Move the RISE Phoenix collection NFT token (mint hzdZak4…) to the incinerator's
// associated token account, for good (audit M3; owner decision 2026-11-24).
//
//   node incinerate_collection.cjs                               dry-run: read-only gates + simulation
//   node incinerate_collection.cjs --send --confirm-mainnet      create the incinerator ATA if needed + transfer
//   node incinerate_collection.cjs --verify                      read-only: the token is at the incinerator ATA
//
// Options: --rpc <url>, --program <id>, --priority <µLamports/CU>,
//          --holder-keypair <path>   current holder (default ~/.config/solana/rise-mint-authority.json = BAMEPcc…)
//
// Why: whoever holds the collection token can Metaplex-BurnNft the collection NFT, which
// WIPES its metadata, even when it is locked (audit M3, probe D). The incinerator
// 1nc1nerator1111… is OFF the ed25519 curve, so no private key for it exists.
//
// What the incinerator ATA does and does not prevent (tests/svm/tests/incinerator.rs, on
// LiteSVM's Token program AND X1 mainnet's own Token binary, whose upgrade authority is NONE):
//   PREVENTED forever: transfer out, approve a delegate, close to anyone else, and Metaplex
//     BurnNft (the metadata wipe), by the former holder or anyone.
//   NOT prevented: an SPL Token Burn by ANYONE, with no signature. SPL Token exempts token
//     accounts owned by the incinerator or the system program from the owner check in Burn,
//     and lets anyone close them (to the incinerator) once empty. Effect: collection NFT
//     supply 1 → 0; metadata, master edition, collection size and members' verified
//     membership stay exactly as they are (tested). Metaplex BurnNft can then never run.
//   A destination that also stops the SPL burn: an ATA owned by the mint_state PDA (no key;
//     the freeze program has no token CPI; permanent after the renounce). Tested, not wired in.
// The destination is not the incinerator account itself, so the runtime's lamport burn of
// 1nc1nerator… does not touch it.
//
// Gates before --send (all must hold; any failure refuses):
//   * the collection metadata FRN2yo3… is LOCKED and at the final royalty, and 500/500
//     members are locked (this is the step AFTER lock-all)
//   * mint hzdZak4…: supply 1, decimals 0, mint + freeze authority = its edition PDA
//   * exactly one token account holds it: amount 1, not frozen, no delegate, owned by
//     the --holder-keypair's public key, at that key's ATA
//   * destination = ATA(incinerator, hzdZak4…) = HQSNbZZ… (re-derived and compared)
// After sending, the destination and source are read back (retried): destination
// amount 1, owner = incinerator, no delegate, no close authority, not frozen; source 0.

const { Connection, PublicKey, Keypair, Transaction, TransactionInstruction, ComputeBudgetProgram, SystemProgram, sendAndConfirmTransaction } = require("@solana/web3.js");
const fs = require("fs");
const K = require("./rise_meta_common.cjs");

const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const INCINERATOR = new PublicKey("1nc1nerator11111111111111111111111111111111");
const EXPECTED_DEST = "HQSNbZZMNuJhQTXsWAZimfiT4PLyyAD5VM2zR23LZfpE"; // ATA(incinerator, hzdZak4…), derived 2026-11-24
const EXPECTED_HOLDER = "BAMEPccJucUMiVnsPJ2V9VzH5m3Q1TD9QDZJhrof4Nxy"; // read 2026-11-24: ATA 5aPXdprGkQ5pqbLoeh7tmvq2YU5itXW8inDCcGSs8fy2
const MINT = new PublicKey(K.COLLECTION_MINT);

const ata = (owner, mint = MINT) => PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0];
const editionPda = (mint = MINT) => PublicKey.findProgramAddressSync([Buffer.from("metadata"), K.MPL.toBuffer(), mint.toBuffer(), Buffer.from("edition")], K.MPL)[0];

// SPL Token account (165 B) and mint (82 B) layouts.
function parseTokenAccount(d) {
  const opt = (o, n) => (d.readUInt32LE(o) === 1 ? d.slice(o + 4, o + 4 + n) : null);
  const del = opt(72, 32), close = opt(129, 32);
  return {
    mint: new PublicKey(d.slice(0, 32)).toBase58(),
    owner: new PublicKey(d.slice(32, 64)).toBase58(),
    amount: d.readBigUInt64LE(64),
    delegate: del ? new PublicKey(del).toBase58() : null,
    state: d[108], // 0 uninitialized, 1 initialized, 2 frozen
    closeAuthority: close ? new PublicKey(close).toBase58() : null,
  };
}
function parseMint(d) {
  return {
    mintAuthority: d.readUInt32LE(0) === 1 ? new PublicKey(d.slice(4, 36)).toBase58() : null,
    supply: d.readBigUInt64LE(36),
    decimals: d[44],
    freezeAuthority: d.readUInt32LE(46) === 1 ? new PublicKey(d.slice(50, 82)).toBase58() : null,
  };
}

// ATA CreateIdempotent (1) + SPL TransferChecked (12) of exactly 1, decimals 0.
function incinerateIxs(holder, source) {
  const dest = ata(INCINERATOR);
  const create = new TransactionInstruction({
    programId: ATA_PROGRAM,
    keys: [
      { pubkey: holder, isSigner: true, isWritable: true },
      { pubkey: dest, isSigner: false, isWritable: true },
      { pubkey: INCINERATOR, isSigner: false, isWritable: false },
      { pubkey: MINT, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
  const amt = Buffer.alloc(8); amt.writeBigUInt64LE(1n);
  const transfer = new TransactionInstruction({
    programId: TOKEN,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: MINT, isSigner: false, isWritable: false },
      { pubkey: dest, isSigner: false, isWritable: true },
      { pubkey: holder, isSigner: true, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([12]), amt, Buffer.from([0])]),
  });
  return [create, transfer];
}

// Everything that must hold before a send. Returns a list of problems.
function gate({ mint, holders, collection, lockedMembers, holder }) {
  const p = [];
  const ed = editionPda().toBase58();
  if (mint.supply !== 1n || mint.decimals !== 0) p.push(`mint supply ${mint.supply} decimals ${mint.decimals}, expected 1 / 0`);
  if (mint.mintAuthority !== ed) p.push(`mint authority ${mint.mintAuthority}, expected the edition PDA ${ed}`);
  if (mint.freezeAuthority !== ed) p.push(`freeze authority ${mint.freezeAuthority}, expected the edition PDA ${ed}`);
  if (!collection) p.push("collection metadata not found");
  else {
    if (collection.isMutable) p.push("collection metadata is not LOCKED yet (run lock_metadata.cjs --all first)");
    if (!K.royaltyIsFinal(collection)) p.push("collection royalty is not final");
  }
  if (lockedMembers !== K.EXPECTED_MEMBERS) p.push(`${lockedMembers}/500 members locked; this step comes after lock-all`);
  const held = holders.filter((h) => h.info.amount > 0n);
  if (held.length !== 1) p.push(`${held.length} token accounts hold the collection token, expected exactly 1`);
  else {
    const h = held[0];
    if (h.address === EXPECTED_DEST) p.push("already at the incinerator ATA: nothing to do (run --verify)");
    else {
      if (h.info.amount !== 1n) p.push(`holder amount ${h.info.amount}`);
      if (h.info.state !== 1) p.push(`holder token account state ${h.info.state} (2 = frozen)`);
      if (h.info.delegate) p.push(`holder token account has a delegate ${h.info.delegate}`);
      if (holder && h.info.owner !== holder) p.push(`token is owned by ${h.info.owner}, the holder keypair is ${holder}`);
      if (h.address !== ata(new PublicKey(h.info.owner)).toBase58()) p.push(`holding account ${h.address} is not the owner's ATA`);
    }
  }
  if (ata(INCINERATOR).toBase58() !== EXPECTED_DEST) p.push("incinerator ATA derivation mismatch");
  return p;
}

// The end state: destination holds the token, nobody can act for it.
function checkIncinerated(dest, source) {
  const p = [];
  if (!dest) return ["incinerator ATA does not exist"];
  if (dest.mint !== K.COLLECTION_MINT) p.push(`dest mint ${dest.mint}`);
  if (dest.owner !== INCINERATOR.toBase58()) p.push(`dest owner ${dest.owner}`);
  if (dest.amount !== 1n) p.push(`dest amount ${dest.amount}`);
  if (dest.delegate) p.push(`dest delegate ${dest.delegate}`);
  if (dest.closeAuthority) p.push(`dest close authority ${dest.closeAuthority}`);
  if (dest.state !== 1) p.push(`dest state ${dest.state}`);
  if (source && source.amount !== 0n) p.push(`source still holds ${source.amount}`);
  return p;
}

async function readState(c, MINT_STATE) {
  const mi = await c.getAccountInfo(MINT);
  if (!mi || !mi.owner.equals(TOKEN)) throw new Error("collection mint not found / not an SPL Token mint");
  const mint = parseMint(mi.data);
  const largest = await c.getTokenLargestAccounts(MINT);
  const holders = [];
  for (const t of largest.value) {
    const a = await c.getAccountInfo(t.address);
    if (a && a.owner.equals(TOKEN)) holders.push({ address: t.address.toBase58(), info: parseTokenAccount(a.data) });
  }
  const { members, collection } = await K.discover(c, MINT_STATE);
  return { mint, holders, collection, lockedMembers: members.filter((m) => !m.isMutable).length };
}

async function main() {
  let a;
  try {
    a = K.parseArgs(process.argv.slice(2), {
      flags: ["--send", "--confirm-mainnet", "--verify"],
      opts: { "--rpc": K.V.url, "--program": K.V.pubkey, "--priority": K.V.nonNegInt, "--holder-keypair": K.V.any },
    });
  } catch (e) { console.error("Refusing:", e.message); process.exit(1); }
  const has = (f) => a.flags.has(f);
  const SEND = has("--send"), VERIFY = has("--verify");
  if (SEND && !has("--confirm-mainnet")) { console.error("Refusing: --send on mainnet requires --confirm-mainnet as well."); process.exit(1); }
  if (SEND && VERIFY) { console.error("Refusing: --verify is read-only."); process.exit(1); }
  const RPC = a.opts["--rpc"] || K.DEFAULT_RPC;
  const PROGRAM = new PublicKey(a.opts["--program"] || K.DEFAULT_PROGRAM);
  const PRIORITY = a.opts["--priority"] !== undefined ? +a.opts["--priority"] : 1_000_000;
  const HOLDER_KP = a.opts["--holder-keypair"] || process.env.HOME + "/.config/solana/rise-mint-authority.json";
  const MINT_STATE = K.mintStatePda(PROGRAM);
  const dest = ata(INCINERATOR);

  const c = new Connection(RPC, "confirmed");
  console.log(`rpc        : ${RPC}\nmint       : ${MINT.toBase58()} (RISE Phoenix collection NFT)`);
  console.log(`destination: ${dest.toBase58()} = ATA(${INCINERATOR.toBase58()}) — off curve: ${!PublicKey.isOnCurve(INCINERATOR.toBuffer())}`);
  console.log(`mode       : ${VERIFY ? "VERIFY (read-only)" : SEND ? "SEND — IRREVERSIBLE" : "DRY-RUN (nothing is signed or sent; no keypair is opened)"}\n`);

  const readDest = async () => {
    const d = await c.getAccountInfo(dest, "confirmed").catch(() => null);
    return d ? parseTokenAccount(d.data) : null;
  };
  if (VERIFY) {
    const p = checkIncinerated(await readDest(), null);
    const st = await readState(c, MINT_STATE);
    const others = st.holders.filter((h) => h.address !== dest.toBase58() && h.info.amount > 0n);
    if (others.length) p.push(`also held by ${others.map((h) => h.address).join(",")}`);
    if (p.length) { console.log("NOT incinerated:\n  " + p.join("\n  ")); process.exit(1); }
    console.log(`OK: ${dest.toBase58()} holds the collection token, owner ${INCINERATOR.toBase58()}, no delegate, no close authority, not frozen.`);
    console.log(`collection metadata ${st.collection.isMutable ? "MUTABLE" : "LOCKED"}, ${st.lockedMembers}/500 members locked`);
    return;
  }

  const st = await readState(c, MINT_STATE);
  const cur = st.holders.find((h) => h.info.amount > 0n);
  console.log(`mint       : supply ${st.mint.supply}, decimals ${st.mint.decimals}, mint/freeze authority ${st.mint.mintAuthority} / ${st.mint.freezeAuthority}`);
  console.log(`holder     : ${cur ? `${cur.address} owner ${cur.info.owner} amount ${cur.info.amount} state ${cur.info.state}` : "none"}`);
  console.log(`state      : collection ${st.collection.isMutable ? "MUTABLE" : "LOCKED"}, ${st.lockedMembers}/500 members locked`);
  console.log(`dest exists: ${!!(await readDest())} (created by the same transaction if not)\n`);

  let holderKey = null, kp = null;
  if (SEND) {
    kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(HOLDER_KP))));
    holderKey = kp.publicKey.toBase58();
  }
  const problems = gate({ ...st, holder: holderKey });
  if (problems.length) console.log("gates:\n  " + problems.join("\n  "));
  else console.log("gates: all pass");

  const holder = new PublicKey(cur ? cur.info.owner : EXPECTED_HOLDER);
  const source = new PublicKey(cur ? cur.address : ata(holder).toBase58());
  const buildTx = () => {
    const tx = new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY }))
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }));
    for (const ix of incinerateIxs(holder, source)) tx.add(ix);
    tx.feePayer = holder;
    return tx;
  };

  if (!SEND) {
    if (cur && cur.address !== dest.toBase58()) {
      const tx = buildTx();
      tx.recentBlockhash = (await c.getLatestBlockhash()).blockhash;
      const sim = await c.simulateTransaction(tx).catch((e) => ({ value: { err: e.message, logs: [] } }));
      console.log(`\nsimulation (${holder.toBase58()} → ${dest.toBase58()}): ${sim.value.err ? "FAILS " + JSON.stringify(sim.value.err) : `ok (${sim.value.unitsConsumed} CU)`}`);
      if (sim.value.err) (sim.value.logs || []).slice(-6).forEach((l) => console.log("   " + l));
    }
    console.log("\nNote: after this move anyone can SPL-burn the token (supply → 0); the metadata cannot be wiped. See the header.");
    console.log(`\nDry run. Nothing sent.${problems.length ? " --send would REFUSE (gates above)." : " --send --confirm-mainnet would move the token for good."}`);
    return;
  }

  if (problems.length) { console.error("\nRefusing: gates failed. Nothing sent."); process.exit(1); }
  console.log(`\nsigning as ${holderKey}; transferring the collection token to ${dest.toBase58()} …`);
  const sig = await sendAndConfirmTransaction(c, buildTx(), [kp], { commitment: "confirmed" });
  console.log(`sent: ${sig}`);
  let p = [];
  for (let i = 1; i <= 6; i++) {
    const s = await c.getAccountInfo(source, "confirmed").catch(() => null);
    p = checkIncinerated(await readDest(), s ? parseTokenAccount(s.data) : null);
    if (!p.length) break;
    await new Promise((r) => setTimeout(r, 1500 * i));
  }
  if (p.length) { console.log("\nSTOP: post-send check failed:\n  " + p.join("\n  ")); process.exit(2); }
  console.log(`\nOK: ${dest.toBase58()} holds the collection token (owner ${INCINERATOR.toBase58()}); ${source.toBase58()} is empty.`);
  console.log(`Optional: reclaim the empty account's rent: spl-token close --address ${source.toBase58()} --owner <holder keypair> --url <rpc>`);
}

if (require.main === module) main().catch((e) => { console.error("ERR", e.message); process.exit(1); });
module.exports = { incinerateIxs, gate, checkIncinerated, parseTokenAccount, parseMint, ata, editionPda, INCINERATOR, EXPECTED_DEST };
