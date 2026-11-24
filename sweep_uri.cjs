// Sweep the RISE Phoenix on-chain metadata URIs off the Vercel site
// (https://rise-phoenix-nft.vercel.app/api/metadata/N) to new per-token URIs,
// via the program's authority-gated `update_token_uri`.
//
//   node sweep_uri.cjs --map uri_map.json                       dry-run, all 500 members (simulates the first)
//   node sweep_uri.cjs --map uri_map.json --token 7             dry-run, one member
//   node sweep_uri.cjs --map uri_map.json --token 7 --send --confirm-mainnet   PILOT: send one
//   node sweep_uri.cjs --map uri_map.json --send --confirm-mainnet             SWEEP: all remaining members
//   node sweep_uri.cjs --map uri_map.json --collection [--send --confirm-mainnet]   the collection NFT
//   node sweep_uri.cjs --map uri_map.json --verify [--token N | --collection]       read-only checks
//
// Map file (pin_metadata.cjs writes it): {"0": "https://…", …, "499": "https://…", "collection": "https://…"}
// Numbering: on-chain "RISE Phoenix #N" = map key "N" = file N-v3.json = JSON name "RISE Phoenix #(N+1)".
//
// Options: --rpc <url>, --program <id>, --authority-keypair <path>, --limit <n>,
//          --priority <microLamports per CU> (default 1000000),
//          --revert   send targets back to the ORIGINAL Vercel URI (members: …/metadata/N,
//                     collection: …/metadata/0). The undo for a pilot or partial sweep. Needs no --map.
//          --skip-vercel-compare        (verify) don't fetch Vercel; use once the site is gone
//          --allow-vercel-diff <paths>  (verify) comma list of JSON paths allowed to differ from Vercel,
//                                       e.g. image,properties.files.0.uri  (default: none)
//
// Safety:
//   * Dry-run is the default and never reads a keypair file.
//   * --send without --confirm-mainnet refuses. Unknown or malformed arguments refuse.
//   * Members are only those whose collection is VERIFIED = hzdZak4…; exactly 500, numbered 0..499 (S2).
//   * Tokens already on their target URI are skipped, so reruns only touch what is left.
//   * Tokens whose metadata is locked (is_mutable = false) cannot change; the run refuses.
//   * After each send the account is read back (retried, S6): uri must equal the target and every
//     other field (including the raw trailing bytes) must equal its pre-send value. Else exit 2.
//   * --verify (S1): JSON name must be "RISE Phoenix #(N+1)" (and attribute Number N+1), and the new
//     JSON must equal, field for field, what Vercel serves today for the same N.

const { Connection, PublicKey, Keypair, Transaction, TransactionInstruction, ComputeBudgetProgram, sendAndConfirmTransaction } = require("@solana/web3.js");
const crypto = require("crypto"), fs = require("fs");
const K = require("./rise_meta_common.cjs");

// ── Map ────────────────────────────────────────────────────────────────
function loadMap(p) {
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  const problems = K.checkMap(raw);
  if (problems.length) {
    console.error(`map ${p} rejected (${problems.length} problems):`);
    problems.slice(0, 40).forEach((x) => console.error("  " + x));
    process.exit(1);
  }
  return raw;
}

// ── Instruction ────────────────────────────────────────────────────────
const DISC = crypto.createHash("sha256").update("global:update_token_uri").digest().slice(0, 8);
function updateTokenUriIx(program, mintState, authority, mint, uri) {
  const uriBuf = Buffer.from(uri, "utf8");
  const len = Buffer.alloc(4); len.writeUInt32LE(uriBuf.length);
  return new TransactionInstruction({
    programId: program,
    keys: [
      { pubkey: mintState, isSigner: false, isWritable: false },
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: K.mdPda(mint), isSigner: false, isWritable: true },
      { pubkey: K.MPL, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([DISC, len, uriBuf]),
  });
}

// ── HTTP (verify) ──────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url, timeoutMs, tries = 3) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
      if (res.status >= 300 && res.status < 400) throw new Error(`HTTP ${res.status} redirect -> ${res.headers.get("location")}`);
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (e) { lastErr = e; if (i < tries) await sleep(1000 * i); }
  }
  throw lastErr;
}
async function getJson(url) {
  const res = await get(url, 30000);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return JSON.parse(await res.text());
}
// Checks a member JSON against the numbering rule. Returns a list of problems.
function checkMemberJson(n, meta) {
  const p = [];
  const want = `RISE Phoenix #${n + 1}`;
  if (meta.name !== want) p.push(`JSON name is ${JSON.stringify(meta.name)}, want ${JSON.stringify(want)} (on-chain #${n} = JSON #${n + 1})`);
  const numAttr = (meta.attributes || []).find((a) => a && a.trait_type === "Number");
  if (numAttr && numAttr.value !== n + 1) p.push(`attribute Number is ${JSON.stringify(numAttr.value)}, want ${n + 1}`);
  return p;
}
async function checkImage(meta) {
  if (!meta.image || typeof meta.image !== "string") return "JSON has no image";
  if (meta.image.includes(K.OLD_HOST)) return `image still on ${K.OLD_HOST}`;
  if (!meta.image.startsWith("https://")) return `image is not https: ${meta.image}`;
  const res = await get(meta.image, 60000);
  if (!res.ok) return `image HTTP ${res.status} ${meta.image}`;
  const body = Buffer.from(await res.arrayBuffer()); // full download, not a HEAD or Range probe
  const ct = res.headers.get("content-type") || "";
  if (!body.length) return "image is empty";
  if (!ct.startsWith("image/")) return `image content-type "${ct}"`;
  return null;
}

async function main() {
  let a;
  try {
    a = K.parseArgs(process.argv.slice(2), {
      flags: ["--send", "--confirm-mainnet", "--verify", "--revert", "--collection", "--skip-vercel-compare"],
      opts: {
        "--map": K.V.any, "--token": K.V.tokenNumber, "--limit": K.V.positiveInt, "--rpc": K.V.url,
        "--program": K.V.pubkey, "--priority": K.V.nonNegInt, "--authority-keypair": K.V.any, "--allow-vercel-diff": K.V.any,
      },
    });
  } catch (e) { console.error("Refusing:", e.message); process.exit(1); }
  const has = (f) => a.flags.has(f);
  const SEND = has("--send"), VERIFY = has("--verify"), REVERT = has("--revert"), COLL = has("--collection");
  const ONLY_TOKEN = a.opts["--token"] !== undefined ? +a.opts["--token"] : null;
  const LIMIT = a.opts["--limit"] !== undefined ? +a.opts["--limit"] : 0;
  const MAP_PATH = a.opts["--map"] || null;
  const RPC = a.opts["--rpc"] || K.DEFAULT_RPC;
  const PROGRAM = new PublicKey(a.opts["--program"] || K.DEFAULT_PROGRAM);
  const PRIORITY = a.opts["--priority"] !== undefined ? +a.opts["--priority"] : 1_000_000;
  const AUTH_KP = a.opts["--authority-keypair"] || process.env.HOME + "/.config/solana/rise-mint-authority.json";
  const ALLOW_DIFF = (a.opts["--allow-vercel-diff"] || "").split(",").map((s) => s.trim()).filter(Boolean);

  if (SEND && !has("--confirm-mainnet")) { console.error("Refusing: --send on mainnet requires --confirm-mainnet as well."); process.exit(1); }
  if (!REVERT && !MAP_PATH) { console.error("--map <file> is required (or --revert to go back to the Vercel URIs)."); process.exit(1); }
  if (REVERT && VERIFY) { console.error("--verify checks the map targets; it cannot be combined with --revert."); process.exit(1); }
  if (SEND && VERIFY) { console.error("--verify is read-only; it cannot be combined with --send."); process.exit(1); }
  if (COLL && ONLY_TOKEN !== null) { console.error("--collection and --token are exclusive."); process.exit(1); }

  const map = REVERT ? null : loadMap(MAP_PATH);
  const targetUri = (n) => (n === K.COLLECTION_KEY ? (REVERT ? K.COLLECTION_OLD_URI : map[K.COLLECTION_KEY]) : REVERT ? `${K.OLD_BASE}${n}` : map[String(n)]);
  const MINT_STATE = K.mintStatePda(PROGRAM);
  const label = (m) => (m.pda === K.COLLECTION_METADATA ? "collection" : `#${K.num(m)}`);
  const keyOf = (m) => (m.pda === K.COLLECTION_METADATA ? K.COLLECTION_KEY : K.num(m));

  const c = new Connection(RPC, "confirmed");
  console.log(`rpc       : ${RPC}`);
  console.log(`program   : ${PROGRAM.toBase58()}`);
  console.log(`mint_state: ${MINT_STATE.toBase58()}`);
  console.log(`target    : ${REVERT ? `REVERT to ${K.OLD_BASE}N` : `map ${MAP_PATH} (${Object.keys(map).length} entries)`}`);
  console.log(`scope     : ${COLL ? "collection NFT only" : ONLY_TOKEN !== null ? `member #${ONLY_TOKEN}` : "all 500 members"}`);
  console.log(`mode      : ${VERIFY ? "VERIFY (read-only)" : SEND ? "SEND" : "DRY-RUN (nothing is signed or sent)"}\n`);

  const ms = await c.getAccountInfo(MINT_STATE);
  if (!ms) throw new Error("mint_state account not found on this cluster");
  const authority = new PublicKey(ms.data.slice(12, 44));
  console.log(`authority : ${authority.toBase58()} (from mint_state)`);

  const { members, collection, ignored } = await K.discover(c, MINT_STATE);
  console.log(`discovered ${members.length} verified members of ${K.COLLECTION_MINT} + the collection NFT` +
    (ignored.length ? ` (${ignored.length} other account(s) naming mint_state as update authority ignored)` : ""));

  let items = COLL ? [collection] : ONLY_TOKEN !== null ? members.filter((m) => K.num(m) === ONLY_TOKEN) : members;
  const missing = items.filter((m) => !targetUri(keyOf(m)));
  if (missing.length) { console.error(`no uri in the map for: ${missing.map(label).join(",")}`); process.exit(1); }

  // ── Verify (read-only, real GET requests) ─────────────────────────────
  if (VERIFY) {
    let ok = 0, wrongUri = 0, bad = 0;
    const problems = [], diffTally = {};
    for (const m of items) {
      const k = keyOf(m), want = targetUri(k), tag = label(m);
      if (m.uri !== want) { wrongUri++; problems.push(`${tag} on-chain uri=${m.uri} (want ${want})`); continue; }
      try {
        const meta = await getJson(want);
        const p = [];
        if (k === K.COLLECTION_KEY) {
          if (meta.name !== "RISE Phoenix") p.push(`collection JSON name is ${JSON.stringify(meta.name)}, want "RISE Phoenix"`);
        } else {
          if (m.collection.key !== K.COLLECTION_MINT || !m.collection.verified) p.push("collection not verified on-chain");
          p.push(...checkMemberJson(k, meta));
          if (!has("--skip-vercel-compare")) {
            const vercel = await getJson(`${K.OLD_BASE}${k}`);
            const diffs = K.jsonDiff(vercel, meta).filter((d) => !ALLOW_DIFF.some((pre) => d === pre || d.startsWith(pre + ":") || d.startsWith(pre + ".")));
            for (const d of diffs) { const path = d.split(":")[0]; diffTally[path] = (diffTally[path] || 0) + 1; }
            if (diffs.length) p.push(`differs from Vercel /api/metadata/${k}: ${diffs.slice(0, 3).join("; ")}${diffs.length > 3 ? ` (+${diffs.length - 3})` : ""}`);
          }
        }
        const imgProblem = await checkImage(meta);
        if (imgProblem) p.push(imgProblem);
        if (p.length) { bad++; problems.push(...p.map((x) => `${tag} ${x}`)); }
        else { ok++; process.stdout.write(`\r${tag} ok  ${m.isMutable ? "mutable" : "LOCKED"}   (${ok}/${items.length})      `); }
      } catch (e) { bad++; problems.push(`${tag} ${e.message}`); }
      await sleep(150);
    }
    console.log(`\n\n${items.length} checked: ${ok} fully ok, ${wrongUri} wrong uri on-chain, ${bad} with problems`);
    if (Object.keys(diffTally).length) {
      console.log("\nfields that differ from Vercel (path: tokens):");
      Object.entries(diffTally).sort((x, y) => y[1] - x[1]).forEach(([p, n]) => console.log(`  ${p}: ${n}`));
    }
    if (problems.length) { console.log("\nproblems:"); problems.slice(0, 60).forEach((p) => console.log("  " + p)); process.exit(1); }
    return;
  }

  // ── Diff ─────────────────────────────────────────────────────────────
  let pending = [];
  const locked = [];
  for (const m of items) {
    const want = targetUri(keyOf(m));
    const action = m.uri === want ? "ok (skip)" : m.isMutable ? "UPDATE" : "LOCKED";
    if (action !== "ok (skip)" || items.length === 1) console.log(`${label(m).padStart(10)}  ${m.mint.padEnd(44)}  ${m.uri.slice(0, 52).padEnd(52)} -> ${want}  ${action}`);
    if (action === "UPDATE") pending.push({ m, want });
    if (action === "LOCKED") locked.push(m);
  }
  if (locked.length) { console.error(`\nRefusing: ${locked.length} target(s) are locked (is_mutable = false) and not on their target uri: ${locked.map(label).slice(0, 20).join(",")}`); process.exit(1); }
  console.log(`\n${items.length} target(s): ${items.length - pending.length} already on target, ${pending.length} to update`);
  if (LIMIT && pending.length > LIMIT) { pending = pending.slice(0, LIMIT); console.log(`--limit ${LIMIT}: only processing the first ${LIMIT}`); }
  if (!pending.length) return;

  const buildTx = (auth, m, uri) => {
    const tx = new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY }))
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 })) // ~42k measured offline
      .add(updateTokenUriIx(PROGRAM, MINT_STATE, auth, m.mint, uri));
    tx.feePayer = auth;
    return tx;
  };

  // ── Dry run: simulate the first one (read-only, no signature) ────────
  if (!SEND) {
    const { m, want } = pending[0];
    const tx = buildTx(authority, m, want);
    tx.recentBlockhash = (await c.getLatestBlockhash()).blockhash;
    const sim = await c.simulateTransaction(tx).catch((e) => ({ value: { err: e.message, logs: [] } }));
    console.log(`\nsimulation of ${label(m)}: ${sim.value.err ? "FAILS " + JSON.stringify(sim.value.err) : `ok (${sim.value.unitsConsumed} CU)`}`);
    if (sim.value.err) {
      (sim.value.logs || []).slice(-6).forEach((l) => console.log("   " + l));
      console.log("   (InstructionFallbackNotFound / 0x65 = the deployed program does not have update_token_uri)");
    }
    console.log("\nDry run. Nothing sent. Add --send --confirm-mainnet to execute.");
    return;
  }

  // ── Send ─────────────────────────────────────────────────────────────
  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(AUTH_KP))));
  if (!kp.publicKey.equals(authority)) throw new Error(`${AUTH_KP} is ${kp.publicKey.toBase58()}, not mint_state.authority ${authority.toBase58()}`);
  console.log(`\nsigning as ${kp.publicKey.toBase58()}`);
  console.log(`sending ${pending.length} transaction(s) to ${RPC}…\n`);

  let sent = 0, failed = 0;
  const failures = [];
  for (const { m, want } of pending) {
    process.stdout.write(`${label(m).padStart(10)} … `);
    let sig;
    try {
      sig = await sendAndConfirmTransaction(c, buildTx(kp.publicKey, m, want), [kp], { commitment: "confirmed" });
    } catch (e) {
      console.log(`FAILED — ${e.message.split("\n")[0].slice(0, 140)}`);
      failed++; failures.push({ tag: label(m), error: e.message });
      await sleep(400);
      continue;
    }
    const rb = await K.readBack(c, m.pda, (x) => x.uri === want, (x) => K.fingerprint(x, "uri") === K.fingerprint(m, "uri", "pda"));
    if (!rb.ok) {
      console.log(`${sig}\n\nSTOP: post-send check failed for ${label(m)}${rb.notLanded ? ` (new uri not visible after ${rb.tries} reads; re-run to re-check)` : " (a field other than uri changed)"}.`);
      console.log("before:", JSON.stringify(m));
      console.log("after :", JSON.stringify(rb.after));
      process.exit(2);
    }
    console.log(sig);
    sent++;
    await sleep(400);
  }

  console.log(`\nsent: ${sent}   failed: ${failed}`);
  if (failures.length) {
    console.log("failures (re-run the same command to retry only these):");
    failures.slice(0, 20).forEach((f) => console.log(`  ${f.tag}  ${f.error.split("\n")[0].slice(0, 100)}`));
    process.exit(1);
  }
  if (!REVERT) console.log(`\nAll sent. Next: node sweep_uri.cjs --map ${MAP_PATH} --verify${COLL ? " --collection" : ""}`);
}

if (require.main === module) main().catch((e) => { console.error("ERR", e.message); process.exit(1); });
module.exports = { updateTokenUriIx, loadMap, checkMemberJson, DISC, parseMetadata: K.parseMetadata, num: K.num, fingerprint: K.fingerprint };
