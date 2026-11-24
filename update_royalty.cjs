// Set the FINAL royalty on every RISE Phoenix member and on the collection NFT:
// 300 bps, single creator GZuBHE3f… (share 100, VERIFIED). Owner decision 2026-11-24.
//
//   node update_royalty.cjs                                  dry-run: 500 members (simulates one tx per group)
//   node update_royalty.cjs --token 1                        dry-run, one member
//   node update_royalty.cjs --collection                     dry-run, the collection NFT FRN2yo3…
//   node update_royalty.cjs --token 1 --send --confirm-mainnet       PILOT
//   node update_royalty.cjs --send --confirm-mainnet                 all members still to do
//   node update_royalty.cjs --collection --send --confirm-mainnet    the collection NFT
//
// Options: --rpc <url>, --program <id>, --limit <n>, --priority <µLamports/CU>,
//          --authority-keypair <path>   mint_state.authority BAMEPcc… (default ~/.config/solana/rise-mint-authority.json)
//          --creator-keypair <path>     GZuB…, signs SignMetadata  (default ~/.config/solana/capy-lp-treasury.json)
//          --old-treasury-keypair <path> Gowv5…, signs RemoveCreatorVerification for the 217
//                                       (default ~/.config/solana/rise-treasury.json)
//
// What each token needs (Metaplex rules, proven in tests/svm/tests/royalty_final.rs on
// X1 mainnet's own Token Metadata binary and mainnet bytes):
//   217 at [Gowv5:100 ✓] @ 100 bps     RemoveCreatorVerification(Gowv5) + update_royalty + SignMetadata(GZuB)
//                                       (without the un-verify Metaplex refuses with 55)
//   283 at [mint_state:100 ✓] @ 500    update_royalty + SignMetadata(GZuB)
//   collection, same as the 283        update_royalty + SignMetadata(GZuB)
// All steps of one token are ONE transaction, so a token is never left half-done.
//
// Safety (audit M4):
//   * Members = the shared discovery (K.discover): update authority mint_state AND
//     verified collection hzdZak4… AND name "RISE Phoenix #N", exactly 500, numbered 0..499,
//     each at its mint's metadata PDA. A spoof can never be signed by the treasury keys.
//   * Strict arguments (unknown, repeated, malformed or valueless options refuse).
//   * Dry-run is the default and never opens a keypair. --send needs --confirm-mainnet.
//     Keypairs are read from files only, and each must be the expected public key.
//   * Any token that cannot reach the target (locked, or another verified creator) blocks the run.
//   * After each send the account is read back with retries: royalty must be final and every
//     other field (including raw trailing bytes) unchanged. Else exit 2.
//   * Re-runs skip tokens already final.

const { Connection, PublicKey, Keypair, Transaction, TransactionInstruction, ComputeBudgetProgram, sendAndConfirmTransaction } = require("@solana/web3.js");
const crypto = require("crypto"), fs = require("fs");
const K = require("./rise_meta_common.cjs");

const HOME = process.env.HOME;
const DEFAULT_KP = {
  authority: HOME + "/.config/solana/rise-mint-authority.json",
  creator: HOME + "/.config/solana/capy-lp-treasury.json",
  oldTreasury: HOME + "/.config/solana/rise-treasury.json",
};
const DISC = crypto.createHash("sha256").update("global:update_royalty").digest().slice(0, 8);

// update_royalty(seller_fee_basis_points: u16, creators: Vec<CreatorArg{address, share}>)
function updateRoyaltyIx(program, mintState, authority, metadata, bps = K.FINAL_BPS, creator = K.FINAL_CREATOR) {
  const b = Buffer.alloc(2); b.writeUInt16LE(bps);
  const len = Buffer.alloc(4); len.writeUInt32LE(1);
  return new TransactionInstruction({
    programId: new PublicKey(program),
    keys: [
      { pubkey: new PublicKey(mintState), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(authority), isSigner: true, isWritable: false },
      { pubkey: new PublicKey(metadata), isSigner: false, isWritable: true },
      { pubkey: K.MPL, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([DISC, b, len, new PublicKey(creator).toBuffer(), Buffer.from([100])]),
  });
}
// Metaplex SignMetadata (7) / RemoveCreatorVerification (28): the creator flips its OWN flag.
const creatorFlagIx = (code, metadata, creator) => new TransactionInstruction({
  programId: K.MPL,
  keys: [
    { pubkey: new PublicKey(metadata), isSigner: false, isWritable: true },
    { pubkey: new PublicKey(creator), isSigner: true, isWritable: false },
  ],
  data: Buffer.from([code]),
});
const signMetadataIx = (metadata, creator) => creatorFlagIx(7, metadata, creator);
const removeCreatorVerificationIx = (metadata, creator) => creatorFlagIx(28, metadata, creator);

// The instructions for one token, in order (no compute-budget instructions).
function royaltyIxs(program, mintState, authority, m, plan) {
  const ixs = [];
  for (const a of plan.unverify) ixs.push(removeCreatorVerificationIx(m.pda, a));
  if (plan.update) ixs.push(updateRoyaltyIx(program, mintState, authority, m.pda));
  if (plan.sign) ixs.push(signMetadataIx(m.pda, K.FINAL_CREATOR));
  return ixs;
}

const short = (a) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const fmt = (m) => `${m.fee}bps ` + ((m.creators || []).map((c) => `${short(c.address)}:${c.share}${c.verified ? "✓" : "✗"}`).join(",") || "no-creators");
const steps = (p) => [p.unverify.length ? `unverify ${p.unverify.map(short).join(",")}` : null, p.update ? "update" : null, p.sign ? "sign GZuB" : null].filter(Boolean).join(" + ");

async function main() {
  let a;
  try {
    a = K.parseArgs(process.argv.slice(2), {
      flags: ["--send", "--confirm-mainnet", "--collection"],
      opts: {
        "--token": K.V.tokenNumber, "--limit": K.V.positiveInt, "--rpc": K.V.url, "--program": K.V.pubkey, "--priority": K.V.nonNegInt,
        "--authority-keypair": K.V.any, "--creator-keypair": K.V.any, "--old-treasury-keypair": K.V.any,
      },
    });
  } catch (e) { console.error("Refusing:", e.message); process.exit(1); }
  const has = (f) => a.flags.has(f);
  const SEND = has("--send"), COLL = has("--collection");
  const ONLY_TOKEN = a.opts["--token"] !== undefined ? +a.opts["--token"] : null;
  if (COLL && ONLY_TOKEN !== null) { console.error("Refusing: --collection and --token are exclusive."); process.exit(1); }
  if (SEND && !has("--confirm-mainnet")) { console.error("Refusing: --send on mainnet requires --confirm-mainnet as well."); process.exit(1); }
  const RPC = a.opts["--rpc"] || K.DEFAULT_RPC;
  const PROGRAM = new PublicKey(a.opts["--program"] || K.DEFAULT_PROGRAM);
  const PRIORITY = a.opts["--priority"] !== undefined ? +a.opts["--priority"] : 1_000_000;
  const LIMIT = a.opts["--limit"] !== undefined ? +a.opts["--limit"] : 0;
  const KP = {
    authority: a.opts["--authority-keypair"] || DEFAULT_KP.authority,
    creator: a.opts["--creator-keypair"] || DEFAULT_KP.creator,
    oldTreasury: a.opts["--old-treasury-keypair"] || DEFAULT_KP.oldTreasury,
  };
  const MINT_STATE = K.mintStatePda(PROGRAM);
  const MS = MINT_STATE.toBase58();
  const isColl = (m) => m.pda === K.COLLECTION_METADATA;
  const label = (m) => (isColl(m) ? "collection" : `#${K.num(m)}`);

  const c = new Connection(RPC, "confirmed");
  console.log(`rpc       : ${RPC}\nprogram   : ${PROGRAM.toBase58()}\nmint_state: ${MS}`);
  console.log(`target    : ${K.FINAL_BPS} bps, [${K.FINAL_CREATOR}:100 verified]`);
  console.log(`scope     : ${COLL ? "collection NFT only" : ONLY_TOKEN !== null ? `member #${ONLY_TOKEN}` : "all 500 members"}`);
  console.log(`mode      : ${SEND ? "SEND" : "DRY-RUN (nothing is signed or sent; no keypair is opened)"}\n`);

  const ms = await c.getAccountInfo(MINT_STATE);
  if (!ms) throw new Error("mint_state account not found on this cluster");
  const authority = new PublicKey(ms.data.slice(12, 44));
  const { members, collection, ignored } = await K.discover(c, MINT_STATE);
  console.log(`authority : ${authority.toBase58()} (from mint_state)`);
  console.log(`discovered: ${members.length} verified members of ${K.COLLECTION_MINT} + the collection NFT` +
    (ignored.length ? ` (${ignored.length} other account(s) naming mint_state ignored, never touched)` : ""));

  const items = COLL ? [collection] : ONLY_TOKEN !== null ? members.filter((m) => K.num(m) === ONLY_TOKEN) : members;
  const planned = items.map((m) => ({ m, p: K.royaltyPlan(m, MS) }));
  const groups = {};
  for (const { m, p } of planned) {
    const g = p.done ? "already final" : p.blocked ? `BLOCKED: ${p.blocked}` : `${fmt(m)} -> ${steps(p)}`;
    (groups[g] = groups[g] || []).push(label(m));
  }
  console.log(`\n${items.length} target(s) by current state:`);
  for (const [g, l] of Object.entries(groups)) console.log(`  ${String(l.length).padStart(3)}  ${g}   (${l.slice(0, 6).join(" ")}${l.length > 6 ? " …" : ""})`);
  const blocked = planned.filter((x) => !x.p.done && x.p.blocked);
  if (blocked.length) { console.error(`\nRefusing: ${blocked.length} target(s) cannot reach the final royalty.`); process.exit(1); }
  let pending = planned.filter((x) => !x.p.done);
  console.log(`\n${items.length} target(s): ${items.length - pending.length} already final, ${pending.length} to change` +
    (COLL ? "" : `, of which ${pending.filter((x) => x.p.unverify.length).length} need the Gowv5 un-verify`));
  if (LIMIT && pending.length > LIMIT) { pending = pending.slice(0, LIMIT); console.log(`--limit ${LIMIT}: only processing the first ${LIMIT}`); }
  if (!pending.length) return;

  const buildTx = (auth, m, p) => {
    const tx = new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY }))
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 150_000 })); // 68,454 CU measured for the 3-step tx (LiteSVM, X1 Metaplex)
    for (const ix of royaltyIxs(PROGRAM, MINT_STATE, auth, m, p)) tx.add(ix);
    tx.feePayer = auth;
    return tx;
  };

  if (!SEND) {
    // Read-only simulation of the first pending tx of each distinct step pattern (no signatures).
    const seen = new Set();
    const { blockhash } = await c.getLatestBlockhash();
    for (const { m, p } of pending) {
      const key = steps(p);
      if (seen.has(key)) continue;
      seen.add(key);
      const tx = buildTx(authority, m, p);
      tx.recentBlockhash = blockhash;
      const sim = await c.simulateTransaction(tx).catch((e) => ({ value: { err: e.message, logs: [] } }));
      console.log(`simulation of ${label(m)} (${key}): ${sim.value.err ? "FAILS " + JSON.stringify(sim.value.err) : `ok (${sim.value.unitsConsumed} CU)`}`);
      if (sim.value.err) (sim.value.logs || []).slice(-6).forEach((l) => console.log("   " + l));
    }
    console.log("\nDry run. Nothing sent. Add --send --confirm-mainnet to apply.");
    return;
  }

  // ── Send ─────────────────────────────────────────────────────────────
  const load = (f) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(f))));
  const authKp = load(KP.authority);
  if (!authKp.publicKey.equals(authority)) throw new Error(`${KP.authority} is ${authKp.publicKey.toBase58()}, not mint_state.authority ${authority.toBase58()}`);
  const creatorKp = load(KP.creator);
  if (creatorKp.publicKey.toBase58() !== K.FINAL_CREATOR) throw new Error(`${KP.creator} is ${creatorKp.publicKey.toBase58()}, not ${K.FINAL_CREATOR}`);
  let oldKp = null;
  if (pending.some((x) => x.p.unverify.length)) {
    oldKp = load(KP.oldTreasury);
    if (oldKp.publicKey.toBase58() !== K.OLD_TREASURY) throw new Error(`${KP.oldTreasury} is ${oldKp.publicKey.toBase58()}, not ${K.OLD_TREASURY}`);
  }
  console.log(`\nsigning as ${authKp.publicKey.toBase58()} (authority), ${K.FINAL_CREATOR} (creator)${oldKp ? `, ${K.OLD_TREASURY} (un-verify)` : ""}`);

  let sent = 0, failed = 0;
  const failures = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (const { m, p } of pending) {
    process.stdout.write(`${label(m).padStart(10)} … `);
    let sig;
    try {
      const signers = [authKp];
      if (p.sign) signers.push(creatorKp);
      if (p.unverify.length) signers.push(oldKp);
      sig = await sendAndConfirmTransaction(c, buildTx(authKp.publicKey, m, p), signers, { commitment: "confirmed" });
    } catch (e) {
      console.log(`FAILED — ${e.message.split("\n")[0].slice(0, 140)}`);
      failed++; failures.push({ tag: label(m), error: e.message });
      await sleep(400);
      continue;
    }
    const rb = await K.readBack(c, m.pda, K.royaltyIsFinal, (x) => K.fingerprint(x, "fee", "creators") === K.fingerprint(m, "fee", "creators", "pda"));
    if (!rb.ok) {
      console.log(`${sig}\n\nSTOP: post-send check failed for ${label(m)}${rb.notLanded ? ` (final royalty not visible after ${rb.tries} reads; re-run to re-check)` : " (a field other than royalty/creators changed)"}.`);
      console.log("before:", JSON.stringify(m));
      console.log("after :", JSON.stringify(rb.after));
      process.exit(2);
    }
    console.log(sig);
    sent++;
    await sleep(400);
  }
  console.log(`\nupdated: ${sent}   failed: ${failed}`);
  if (failures.length) {
    console.log("failures (re-run the same command to retry only these):");
    failures.slice(0, 20).forEach((f) => console.log(`  ${f.tag}  ${f.error.split("\n")[0].slice(0, 100)}`));
    process.exit(1);
  }
}

if (require.main === module) main().catch((e) => { console.error("ERR", e.message); process.exit(1); });
module.exports = { updateRoyaltyIx, signMetadataIx, removeCreatorVerificationIx, royaltyIxs, DISC };
