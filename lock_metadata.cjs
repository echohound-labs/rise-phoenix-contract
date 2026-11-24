// Lock RISE Phoenix metadata for good: calls the program's `lock_metadata`,
// which sets is_mutable = false through Metaplex. IRREVERSIBLE: after a lock,
// nobody (not the authority, not an upgraded program) can change that token's
// name, symbol, uri, royalty or creators again.
//
//   node lock_metadata.cjs --map uri_map.json --token 7                         dry-run, one member
//   node lock_metadata.cjs --map uri_map.json --token 7 --send --confirm-mainnet   PILOT: lock one
//   node lock_metadata.cjs --map uri_map.json --all                             dry-run, 500 members + collection
//   node lock_metadata.cjs --map uri_map.json --all --send --confirm-mainnet    lock everything left
//   node lock_metadata.cjs --map uri_map.json --collection [--send --confirm-mainnet]
//   node lock_metadata.cjs --status                                             read-only lock count
//
// Exactly one of --token N, --collection, --all (or --status) is required.
//
// Gates, checked for every target BEFORE anything is sent (any failure → the run refuses):
//   * uri == the map's target for it, and not on rise-phoenix-nft.vercel.app
//   * members: verified collection hzdZak4… (discovery), and the final royalty:
//       --expect-bps (default 100) and a single creator --expect-creator
//       (default treasury Gowv5PDb…) with share 100, VERIFIED
//   * targets already locked are skipped (lock is idempotent anyway)
//
// After each send the account is read back (retried): is_mutable must be false and
// every other field, including the raw trailing bytes, must be unchanged. Else exit 2.
//
// Options: --rpc <url>, --program <id>, --authority-keypair <path>, --limit <n>, --priority <µLamports/CU>

const { Connection, PublicKey, Keypair, Transaction, TransactionInstruction, ComputeBudgetProgram, sendAndConfirmTransaction } = require("@solana/web3.js");
const crypto = require("crypto"), fs = require("fs");
const K = require("./rise_meta_common.cjs");

const DEFAULT_BPS = 100;
const DEFAULT_CREATOR = "Gowv5PDb7K4a5PwjubWegvBT4CDfjjJcG4QAZWa9yUob"; // rise-treasury, update_royalty.cjs target

const DISC = crypto.createHash("sha256").update("global:lock_metadata").digest().slice(0, 8);
function lockIx(program, mintState, authority, mint) {
  return new TransactionInstruction({
    programId: program,
    keys: [
      { pubkey: mintState, isSigner: false, isWritable: false },
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: K.mdPda(mint), isSigner: false, isWritable: true },
      { pubkey: K.MPL, isSigner: false, isWritable: false },
    ],
    data: DISC,
  });
}

// Why this target must not be locked yet. Empty list = ready.
function gate(m, { isCollection, wantUri, bps, creator }) {
  const p = [];
  if (!wantUri) p.push("no uri in the map");
  else if (m.uri !== wantUri) p.push(`uri is ${m.uri}, map says ${wantUri}`);
  if (m.uri.includes(K.OLD_HOST)) p.push(`uri still on ${K.OLD_HOST}`);
  if (!isCollection) {
    if (!m.collection || !m.collection.verified || m.collection.key !== K.COLLECTION_MINT) p.push("collection not verified");
    if (m.fee !== bps) p.push(`royalty ${m.fee} bps, expected ${bps}`);
    const c = m.creators || [];
    if (!(c.length === 1 && c[0].address === creator && c[0].share === 100 && c[0].verified))
      p.push(`creators ${JSON.stringify(c.map((x) => `${x.address.slice(0, 4)}…:${x.share}${x.verified ? "✓" : "✗"}`))}, expected [${creator.slice(0, 4)}…:100✓]`);
  }
  return p;
}

async function main() {
  let a;
  try {
    a = K.parseArgs(process.argv.slice(2), {
      flags: ["--send", "--confirm-mainnet", "--collection", "--all", "--status"],
      opts: {
        "--map": K.V.any, "--token": K.V.tokenNumber, "--limit": K.V.positiveInt, "--rpc": K.V.url, "--program": K.V.pubkey,
        "--priority": K.V.nonNegInt, "--authority-keypair": K.V.any, "--expect-bps": K.V.nonNegInt, "--expect-creator": K.V.pubkey,
      },
    });
  } catch (e) { console.error("Refusing:", e.message); process.exit(1); }
  const has = (f) => a.flags.has(f);
  const SEND = has("--send"), STATUS = has("--status");
  const ONLY_TOKEN = a.opts["--token"] !== undefined ? +a.opts["--token"] : null;
  const scopes = [ONLY_TOKEN !== null, has("--collection"), has("--all"), STATUS].filter(Boolean).length;
  if (scopes !== 1) { console.error("Refusing: give exactly one of --token N, --collection, --all, --status."); process.exit(1); }
  if (SEND && !has("--confirm-mainnet")) { console.error("Refusing: --send on mainnet requires --confirm-mainnet as well."); process.exit(1); }
  if (SEND && STATUS) { console.error("Refusing: --status is read-only."); process.exit(1); }
  if (!STATUS && !a.opts["--map"]) { console.error("--map uri_map.json is required: a token is only locked once its uri equals the map's final uri."); process.exit(1); }

  const RPC = a.opts["--rpc"] || K.DEFAULT_RPC;
  const PROGRAM = new PublicKey(a.opts["--program"] || K.DEFAULT_PROGRAM);
  const PRIORITY = a.opts["--priority"] !== undefined ? +a.opts["--priority"] : 1_000_000;
  const LIMIT = a.opts["--limit"] !== undefined ? +a.opts["--limit"] : 0;
  const AUTH_KP = a.opts["--authority-keypair"] || process.env.HOME + "/.config/solana/rise-mint-authority.json";
  const bps = a.opts["--expect-bps"] !== undefined ? +a.opts["--expect-bps"] : DEFAULT_BPS;
  const creator = a.opts["--expect-creator"] || DEFAULT_CREATOR;
  let map = null;
  if (a.opts["--map"]) {
    map = JSON.parse(fs.readFileSync(a.opts["--map"], "utf8"));
    const problems = K.checkMap(map);
    if (problems.length) { console.error(`map rejected:\n  ${problems.slice(0, 40).join("\n  ")}`); process.exit(1); }
  }
  const MINT_STATE = K.mintStatePda(PROGRAM);
  const isColl = (m) => m.pda === K.COLLECTION_METADATA;
  const label = (m) => (isColl(m) ? "collection" : `#${K.num(m)}`);

  const c = new Connection(RPC, "confirmed");
  console.log(`rpc       : ${RPC}\nprogram   : ${PROGRAM.toBase58()}\nmint_state: ${MINT_STATE.toBase58()}`);
  console.log(`mode      : ${STATUS ? "STATUS (read-only)" : SEND ? "SEND — IRREVERSIBLE" : "DRY-RUN (nothing is signed or sent)"}`);
  if (!STATUS) console.log(`gate      : uri == map, members at ${bps} bps with [${creator}:100 verified]\n`);

  const ms = await c.getAccountInfo(MINT_STATE);
  if (!ms) throw new Error("mint_state account not found on this cluster");
  const authority = new PublicKey(ms.data.slice(12, 44));
  const { members, collection } = await K.discover(c, MINT_STATE);
  const lockedCount = members.filter((m) => !m.isMutable).length;
  console.log(`authority : ${authority.toBase58()} (from mint_state)`);
  console.log(`state     : ${lockedCount}/500 members locked, collection ${collection.isMutable ? "mutable" : "LOCKED"}`);
  if (STATUS) return;

  let items = has("--collection") ? [collection] : ONLY_TOKEN !== null ? members.filter((m) => K.num(m) === ONLY_TOKEN) : [...members, collection];
  const already = items.filter((m) => !m.isMutable);
  items = items.filter((m) => m.isMutable);
  const blocked = [];
  for (const m of items) {
    const p = gate(m, { isCollection: isColl(m), wantUri: map[isColl(m) ? K.COLLECTION_KEY : String(K.num(m))], bps, creator });
    if (p.length) blocked.push({ m, p });
  }
  console.log(`\ntargets   : ${items.length + already.length} (${already.length} already locked, skipped), ${items.length - blocked.length} ready, ${blocked.length} BLOCKED`);
  if (blocked.length) {
    blocked.slice(0, 40).forEach(({ m, p }) => console.log(`  ${label(m).padStart(10)}  ${p.join("; ")}`));
    if (blocked.length > 40) console.log(`  … and ${blocked.length - 40} more`);
    console.error("\nRefusing: lock is irreversible; fix the blocked targets first (sweep_uri.cjs / update_royalty.cjs).");
    process.exit(1);
  }
  let pending = items;
  if (LIMIT && pending.length > LIMIT) { pending = pending.slice(0, LIMIT); console.log(`--limit ${LIMIT}: only processing the first ${LIMIT}`); }
  if (!pending.length) { console.log("Nothing to lock."); return; }
  if (pending.length <= 3) pending.forEach((m) => console.log(`  ${label(m)}  ${m.mint}  uri ${m.uri}`));

  const buildTx = (auth, m) => {
    const tx = new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY }))
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 })) // 24,050 CU measured offline (LiteSVM)
      .add(lockIx(PROGRAM, MINT_STATE, auth, m.mint));
    tx.feePayer = auth;
    return tx;
  };

  if (!SEND) {
    const m = pending[0];
    const tx = buildTx(authority, m);
    tx.recentBlockhash = (await c.getLatestBlockhash()).blockhash;
    const sim = await c.simulateTransaction(tx).catch((e) => ({ value: { err: e.message, logs: [] } }));
    console.log(`\nsimulation of ${label(m)}: ${sim.value.err ? "FAILS " + JSON.stringify(sim.value.err) : `ok (${sim.value.unitsConsumed} CU)`}`);
    if (sim.value.err) {
      (sim.value.logs || []).slice(-6).forEach((l) => console.log("   " + l));
      console.log("   (InstructionFallbackNotFound / 0x65 = the deployed program does not have lock_metadata yet)");
    }
    console.log(`\nDry run. Nothing sent. ${pending.length} target(s) would be locked PERMANENTLY with --send --confirm-mainnet.`);
    return;
  }

  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(AUTH_KP))));
  if (!kp.publicKey.equals(authority)) throw new Error(`${AUTH_KP} is ${kp.publicKey.toBase58()}, not mint_state.authority ${authority.toBase58()}`);
  console.log(`\nsigning as ${kp.publicKey.toBase58()}; locking ${pending.length} target(s)…\n`);

  let sent = 0, failed = 0;
  const failures = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (const m of pending) {
    process.stdout.write(`${label(m).padStart(10)} … `);
    let sig;
    try {
      sig = await sendAndConfirmTransaction(c, buildTx(kp.publicKey, m), [kp], { commitment: "confirmed" });
    } catch (e) {
      console.log(`FAILED — ${e.message.split("\n")[0].slice(0, 140)}`);
      failed++; failures.push({ tag: label(m), error: e.message });
      await sleep(400);
      continue;
    }
    const rb = await K.readBack(c, m.pda, (x) => x.isMutable === false, (x) => K.fingerprint(x, "isMutable") === K.fingerprint(m, "isMutable", "pda"));
    if (!rb.ok) {
      console.log(`${sig}\n\nSTOP: post-send check failed for ${label(m)}${rb.notLanded ? ` (is_mutable still true after ${rb.tries} reads; re-run to re-check)` : " (a field other than is_mutable changed)"}.`);
      console.log("before:", JSON.stringify(m));
      console.log("after :", JSON.stringify(rb.after));
      process.exit(2);
    }
    console.log(sig);
    sent++;
    await sleep(400);
  }
  console.log(`\nlocked: ${sent}   failed: ${failed}`);
  if (failures.length) {
    console.log("failures (re-run the same command to retry only these):");
    failures.slice(0, 20).forEach((f) => console.log(`  ${f.tag}  ${f.error.split("\n")[0].slice(0, 100)}`));
    process.exit(1);
  }
  console.log("\nNext: node lock_metadata.cjs --status   (and node sweep_uri.cjs --map … --verify)");
}

if (require.main === module) main().catch((e) => { console.error("ERR", e.message); process.exit(1); });
module.exports = { lockIx, gate, DISC };
