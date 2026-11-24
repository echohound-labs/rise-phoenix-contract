// Read-only checks for the owner's freeze steps. Never opens a keypair, never signs or sends.
//
//   node readonly_checks.cjs editions [--rpc URL]
//       Audit A1 (before the upgrade): all 500 member mints + the collection mint have a
//       MasterEditionV2 with max_supply 0, mint AND freeze authority = the edition PDA, supply 1.
//       Expected: "501/501 MasterEditionV2 max_supply 0, mint+freeze authority = edition PDA, supply 1"
//
//   node readonly_checks.cjs update-sim --token N [--rpc URL]
//   node readonly_checks.cjs update-sim --collection [--rpc URL]
//       Simulates (unsigned) an update_token_uri back to the Vercel uri on that token.
//       Before its lock: err null. After its lock: {"InstructionError":[0,{"Custom":59}]}
//       (Metaplex DataIsImmutable) — the on-chain confirmation that the lock holds.

const { Connection, PublicKey, Transaction } = require("@solana/web3.js");
const K = require("./rise_meta_common.cjs");
const S = require("./sweep_uri.cjs");

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  let a;
  try {
    if (!["editions", "update-sim"].includes(cmd)) throw new Error("first argument must be editions or update-sim");
    a = K.parseArgs(rest, { flags: cmd === "update-sim" ? ["--collection"] : [], opts: cmd === "update-sim" ? { "--rpc": K.V.url, "--token": K.V.tokenNumber } : { "--rpc": K.V.url } });
    if (cmd === "update-sim" && (a.opts["--token"] === undefined) === !a.flags.has("--collection")) throw new Error("give exactly one of --token N, --collection");
  } catch (e) { console.error("Refusing:", e.message); process.exit(1); }
  const c = new Connection(a.opts["--rpc"] || K.DEFAULT_RPC, "confirmed");
  const P = new PublicKey(K.DEFAULT_PROGRAM), MS = K.mintStatePda(P);
  const { members, collection } = await K.discover(c, MS);

  if (cmd === "editions") {
    const ed = (m) => PublicKey.findProgramAddressSync([Buffer.from("metadata"), K.MPL.toBuffer(), new PublicKey(m).toBuffer(), Buffer.from("edition")], K.MPL)[0];
    const mints = [...members.map((m) => m.mint), K.COLLECTION_MINT];
    let ok = 0; const bad = [];
    for (let i = 0; i < mints.length; i += 100) {
      const ch = mints.slice(i, i + 100);
      const [eds, ms] = await Promise.all([c.getMultipleAccountsInfo(ch.map(ed)), c.getMultipleAccountsInfo(ch.map((m) => new PublicKey(m)))]);
      ch.forEach((m, j) => {
        const e = eds[j], t = ms[j], E = ed(m).toBase58();
        const good = e && e.owner.equals(K.MPL) && e.data[0] === 6 /* MasterEditionV2 */ && e.data.readBigUInt64LE(1) === 0n &&
          e.data[9] === 1 && e.data.readBigUInt64LE(10) === 0n /* max_supply Some(0) */ &&
          t && t.data.readUInt32LE(0) === 1 && new PublicKey(t.data.slice(4, 36)).toBase58() === E && t.data.readBigUInt64LE(36) === 1n &&
          t.data.readUInt32LE(46) === 1 && new PublicKey(t.data.slice(50, 82)).toBase58() === E;
        good ? ok++ : bad.push(m);
      });
    }
    console.log(`${ok}/${mints.length} MasterEditionV2 max_supply 0, mint+freeze authority = edition PDA, supply 1` + (bad.length ? `\nBAD: ${bad.join(",")}` : ""));
    if (bad.length || ok !== 501) process.exit(1);
    return;
  }

  const coll = a.flags.has("--collection");
  const m = coll ? collection : members.find((x) => K.num(x) === +a.opts["--token"]);
  const authority = new PublicKey((await c.getAccountInfo(MS)).data.slice(12, 44));
  const tx = new Transaction().add(S.updateTokenUriIx(P, MS, authority, m.mint, coll ? K.COLLECTION_OLD_URI : K.OLD_BASE + K.num(m)));
  tx.feePayer = authority;
  tx.recentBlockhash = (await c.getLatestBlockhash()).blockhash;
  const r = await c.simulateTransaction(tx);
  console.log(`${coll ? "collection" : "#" + K.num(m)}: is_mutable ${m.isMutable}; simulated update_token_uri err: ${JSON.stringify(r.value.err)}`);
}

main().catch((e) => { console.error("ERR", e.message); process.exit(1); });
