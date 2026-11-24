// Sweep the RISE Phoenix on-chain metadata URIs off the Vercel site
// (https://rise-phoenix-nft.vercel.app/api/metadata/N) to new per-token URIs,
// via the program's authority-gated `update_token_uri`. Ported from
// cappy-nft-mint's sweep_uri.cjs; discovery, parsing and the authority keypair
// path match this repo's update_royalty.cjs.
//
//   node sweep_uri.cjs --map uri_map.json                       dry-run, mainnet, all 500 (simulates the first)
//   node sweep_uri.cjs --map uri_map.json --token 7             dry-run, one token
//   node sweep_uri.cjs --map uri_map.json --token 7 --send --confirm-mainnet   PILOT: send one
//   node sweep_uri.cjs --map uri_map.json --send --confirm-mainnet             SWEEP: send all remaining
//   node sweep_uri.cjs --map uri_map.json --verify              read-only: GET every on-chain URI and
//                                                               its image, check on-chain fields too
//
// Map file: JSON object, token number -> full new URI, e.g.
//   { "0": "https://.../0.json", "1": "ipfs://.../1.json", ... "499": "..." }
// Token number N is the N in the on-chain name "RISE Phoenix #N" (0..499).
//
// Other flags: --limit N, --rpc <url>, --program <id>, --authority-keypair <path>,
//              --priority <microLamports per CU> (default 1000000), --revert
//   --revert  targets the ORIGINAL Vercel URI (BASE_URI + N) instead of the map:
//             the undo for a pilot or a partial sweep. Needs no --map.
//
// Safety:
//   * Dry-run is the default and never reads a keypair file.
//   * --send without --confirm-mainnet refuses to run.
//   * Tokens already on their target URI are skipped, so reruns only touch what is left.
//   * After each send the account is read back: uri must equal the target and every other
//     field (name, symbol, fee, creators+verified, collection+verified, uses,
//     primary_sale_happened, is_mutable, update authority) must equal its pre-send value.
//     Any mismatch stops the sweep.
//   * The parent collection NFT (no "#N" in its name) is never touched.

const { Connection, PublicKey, Keypair, Transaction, TransactionInstruction, ComputeBudgetProgram, sendAndConfirmTransaction } = require("@solana/web3.js");
const crypto = require("crypto"), fs = require("fs");

const DEFAULT_RPC = "https://rpc.mainnet.x1.xyz";
const DEFAULT_PROGRAM = "5QUVVnm1duiRazqa69KW9ZQhCCZcg5GBUKkUn5avA8Gb";
const MPL = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const OLD_BASE = "https://rise-phoenix-nft.vercel.app/api/metadata/"; // BASE_URI in lib.rs
const OLD_HOST = "rise-phoenix-nft.vercel.app";
const MAX_URI_LENGTH = 200; // Metaplex limit, enforced on-chain too (UriTooLong 6005)
const EXPECTED_MEMBERS = 500;

// ── Args ───────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const SEND = flag("--send");
const CONFIRM = flag("--confirm-mainnet");
const VERIFY = flag("--verify");
const REVERT = flag("--revert");
const ONLY_TOKEN = opt("--token", null);
const LIMIT = +opt("--limit", 0);
const MAP_PATH = opt("--map", null);
const RPC = opt("--rpc", DEFAULT_RPC);
const PROGRAM = new PublicKey(opt("--program", DEFAULT_PROGRAM));
const PRIORITY = +opt("--priority", 1_000_000);
const AUTH_KP = opt("--authority-keypair", process.env.HOME + "/.config/solana/rise-mint-authority.json");

const [MINT_STATE] = PublicKey.findProgramAddressSync([Buffer.from("mint_state_v2")], PROGRAM);
const mdPda = (mint) => PublicKey.findProgramAddressSync([Buffer.from("metadata"), MPL.toBuffer(), mint.toBuffer()], MPL)[0];

// ── Target map ─────────────────────────────────────────────────────────
function loadMap(p) {
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  if (typeof raw !== "object" || Array.isArray(raw) || raw === null) throw new Error(`${p}: expected a JSON object {"N": "uri"}`);
  const problems = [];
  const seen = new Map();
  for (const [k, v] of Object.entries(raw)) {
    if (!/^\d+$/.test(k) || +k >= EXPECTED_MEMBERS) problems.push(`key "${k}": not a token number 0..${EXPECTED_MEMBERS - 1}`);
    if (typeof v !== "string" || v.length === 0) { problems.push(`#${k}: empty or non-string uri`); continue; }
    const bytes = Buffer.byteLength(v, "utf8");
    if (bytes > MAX_URI_LENGTH) problems.push(`#${k}: uri is ${bytes} bytes, Metaplex limit is ${MAX_URI_LENGTH}`);
    if (v !== v.trim()) problems.push(`#${k}: uri has leading/trailing whitespace`);
    if (v.includes(OLD_HOST)) problems.push(`#${k}: uri still points at ${OLD_HOST}`);
    if (!/^(https:\/\/|ipfs:\/\/|ar:\/\/)/.test(v)) problems.push(`#${k}: uri scheme is not https://, ipfs:// or ar://`);
    if (seen.has(v)) problems.push(`#${k}: same uri as #${seen.get(v)}`);
    seen.set(v, k);
  }
  if (problems.length) {
    console.error(`map ${p} rejected (${problems.length} problems):`);
    problems.slice(0, 40).forEach((x) => console.error("  " + x));
    process.exit(1);
  }
  return raw;
}

// ── Metadata parsing (full layout, so the post-send check covers every field) ──
function parseMetadata(d) {
  let o = 0;
  const u8 = () => d[o++];
  const pk = () => { const v = new PublicKey(d.slice(o, o + 32)); o += 32; return v.toBase58(); };
  const str = () => { const n = d.readUInt32LE(o); o += 4; const s = d.slice(o, o + n).toString("utf8").replace(/\0+$/, ""); o += n; return s; };
  const key = u8();
  const ua = pk(), mint = pk();
  const name = str(), symbol = str(), uri = str();
  const fee = d.readUInt16LE(o); o += 2;
  let creators = null;
  if (u8() === 1) {
    const n = d.readUInt32LE(o); o += 4;
    creators = [];
    for (let i = 0; i < n; i++) creators.push({ address: pk(), verified: u8() === 1, share: u8() });
  }
  const primarySaleHappened = u8() === 1;
  const isMutable = u8() === 1;
  const editionNonce = u8() === 1 ? u8() : null;
  const tokenStandard = u8() === 1 ? u8() : null;
  const collection = u8() === 1 ? { verified: u8() === 1, key: pk() } : null;
  let uses = null;
  if (u8() === 1) { uses = { method: u8(), remaining: d.readBigUInt64LE(o).toString(), total: d.readBigUInt64LE(o + 8).toString() }; o += 16; }
  return { key, ua, mint, name, symbol, uri, fee, creators, primarySaleHappened, isMutable, editionNonce, tokenStandard, collection, uses };
}
const num = (m) => { const x = /#(\d+)$/.exec(m.name); return x ? +x[1] : -1; };
// Everything except uri, as a stable string, for before/after comparison.
const fingerprint = (m) => JSON.stringify({ ...m, uri: undefined });

// ── Instruction ────────────────────────────────────────────────────────
const DISC = crypto.createHash("sha256").update("global:update_token_uri").digest().slice(0, 8);
function updateTokenUriIx(authority, mint, uri) {
  const uriBuf = Buffer.from(uri, "utf8");
  const len = Buffer.alloc(4); len.writeUInt32LE(uriBuf.length);
  return new TransactionInstruction({
    programId: PROGRAM,
    keys: [
      { pubkey: MINT_STATE, isSigner: false, isWritable: false },
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: mdPda(new PublicKey(mint)), isSigner: false, isWritable: true },
      { pubkey: MPL, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([DISC, len, uriBuf]),
  });
}
function buildTx(authority, m, uri) {
  const tx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY }))
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 })) // ~42k measured offline
    .add(updateTokenUriIx(authority, m.mint, uri));
  tx.feePayer = authority;
  return tx;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const host = (u) => { try { return new URL(u).host; } catch { return "?"; } };

async function main() {
  if (SEND && !CONFIRM) { console.error("Refusing: --send on mainnet requires --confirm-mainnet as well."); process.exit(1); }
  if (!REVERT && !MAP_PATH) { console.error("--map <file> is required (or --revert to go back to the Vercel URIs)."); process.exit(1); }
  if (REVERT && VERIFY) { console.error("--verify checks the map targets; it cannot be combined with --revert."); process.exit(1); }

  const map = REVERT ? null : loadMap(MAP_PATH);
  const targetUri = (n) => (REVERT ? `${OLD_BASE}${n}` : map[String(n)]);

  const c = new Connection(RPC, "confirmed");
  console.log(`rpc       : ${RPC}`);
  console.log(`program   : ${PROGRAM.toBase58()}`);
  console.log(`mint_state: ${MINT_STATE.toBase58()}`);
  console.log(`target    : ${REVERT ? `REVERT to ${OLD_BASE}N` : `map ${MAP_PATH} (${Object.keys(map).length} entries)`}`);
  console.log(`mode      : ${VERIFY ? "VERIFY (read-only)" : SEND ? "SEND" : "DRY-RUN (nothing is signed or sent)"}\n`);

  const ms = await c.getAccountInfo(MINT_STATE);
  if (!ms) throw new Error("mint_state account not found on this cluster");
  const authority = new PublicKey(ms.data.slice(12, 44));
  console.log(`authority : ${authority.toBase58()} (from mint_state)`);

  // ── Discover ─────────────────────────────────────────────────────────
  const accs = await c.getProgramAccounts(MPL, { filters: [{ memcmp: { offset: 1, bytes: MINT_STATE.toBase58() } }] });
  const all = accs.map((a) => parseMetadata(a.account.data));
  let items = all.filter((m) => num(m) >= 0).sort((a, b) => num(a) - num(b)); // members only
  for (const m of items) if (m.ua !== MINT_STATE.toBase58()) throw new Error(`${m.mint}: update authority is ${m.ua}, not mint_state`);
  const nums = items.map(num);
  const dupes = nums.filter((n, i) => nums.indexOf(n) !== i);
  if (dupes.length) throw new Error(`duplicate token numbers on-chain: ${[...new Set(dupes)].join(",")}`);
  console.log(`discovered ${items.length} RISE Phoenix member NFTs (${all.length - items.length} non-member account(s) skipped, e.g. the collection NFT)`);
  if (items.length !== EXPECTED_MEMBERS) console.log(`WARNING: expected ${EXPECTED_MEMBERS} members, found ${items.length}`);
  const notMember = items.filter((m) => !m.collection || !m.collection.verified);
  if (notMember.length) console.log(`WARNING: ${notMember.length} member(s) without a verified collection: ${notMember.map(num).slice(0, 20).join(",")}`);

  if (ONLY_TOKEN !== null) {
    items = items.filter((m) => num(m) === +ONLY_TOKEN);
    if (!items.length) throw new Error(`token #${ONLY_TOKEN} not found on-chain`);
  }
  const missing = items.filter((m) => !targetUri(num(m)));
  if (missing.length) { console.error(`tokens with no uri in the map: ${missing.map(num).join(",")}`); process.exit(1); }

  // ── Verify mode (read-only, real GET requests) ────────────────────────
  if (VERIFY) {
    let ok = 0, wrongUri = 0, badMeta = 0, badImg = 0;
    const problems = [];
    for (const m of items) {
      const n = num(m);
      const want = targetUri(n);
      if (m.uri !== want) { wrongUri++; problems.push(`#${n} on-chain uri=${m.uri} (want ${want})`); continue; }
      if (!m.collection || !m.collection.verified) { badMeta++; problems.push(`#${n} collection not verified on-chain`); continue; }
      try {
        const fetchUri = want.startsWith("ipfs://") ? null : want;
        if (!fetchUri) throw new Error("ipfs:// URIs need a gateway to verify; use https:// gateway URIs in the map");
        const metaRes = await fetch(fetchUri, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(30000) });
        if (metaRes.status >= 300 && metaRes.status < 400) throw new Error(`meta HTTP ${metaRes.status} redirect -> ${metaRes.headers.get("location")}`);
        if (!metaRes.ok) throw new Error(`meta HTTP ${metaRes.status}`);
        const meta = JSON.parse(await metaRes.text());
        if (typeof meta.name !== "string" || !meta.name.endsWith(`#${n}`)) { badMeta++; problems.push(`#${n} JSON name is ${JSON.stringify(meta.name)}`); continue; }
        if (!meta.image || typeof meta.image !== "string") { badMeta++; problems.push(`#${n} JSON has no image`); continue; }
        if (meta.image.includes(OLD_HOST)) { badMeta++; problems.push(`#${n} image still on ${OLD_HOST}: ${meta.image}`); continue; }
        const imgRes = await fetch(meta.image, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(60000) });
        if (!imgRes.ok) { badImg++; problems.push(`#${n} image HTTP ${imgRes.status} ${meta.image}`); continue; }
        const body = Buffer.from(await imgRes.arrayBuffer()); // full download, not a HEAD or Range probe
        const ct = imgRes.headers.get("content-type") || "";
        if (!body.length) { badImg++; problems.push(`#${n} image is empty`); continue; }
        if (!ct.startsWith("image/")) { badImg++; problems.push(`#${n} image content-type "${ct}"`); continue; }
        ok++;
        process.stdout.write(`\r#${n} ok  ${host(want)}  img ${body.length} B   (${ok}/${items.length})      `);
      } catch (e) {
        badMeta++; problems.push(`#${n} ${e.message}`);
      }
      await sleep(150);
    }
    console.log(`\n\n${items.length} checked: ${ok} fully ok, ${wrongUri} wrong uri on-chain, ${badMeta} metadata problems, ${badImg} image problems`);
    if (problems.length) { console.log("\nproblems:"); problems.slice(0, 40).forEach((p) => console.log("  " + p)); process.exit(1); }
    return;
  }

  // ── Diff ─────────────────────────────────────────────────────────────
  let pending = [];
  for (const m of items) {
    const n = num(m);
    const want = targetUri(n);
    const action = m.uri === want ? "ok (skip)" : "UPDATE";
    if (action === "UPDATE" || ONLY_TOKEN !== null) console.log(`#${String(n).padStart(3)}  ${m.mint.padEnd(44)}  ${m.uri.slice(0, 52).padEnd(52)} -> ${want}  ${action}`);
    if (action === "UPDATE") pending.push({ m, want });
  }
  console.log(`\n${items.length} NFTs: ${items.length - pending.length} already on target, ${pending.length} to update`);
  if (LIMIT && pending.length > LIMIT) { pending = pending.slice(0, LIMIT); console.log(`--limit ${LIMIT}: only processing the first ${LIMIT}`); }
  if (!pending.length) return;

  // ── Dry run: simulate the first one (read-only, no signature) ────────
  if (!SEND) {
    const { m, want } = pending[0];
    const tx = buildTx(authority, m, want);
    tx.recentBlockhash = (await c.getLatestBlockhash()).blockhash;
    const sim = await c.simulateTransaction(tx).catch((e) => ({ value: { err: e.message, logs: [] } }));
    console.log(`\nsimulation of #${num(m)}: ${sim.value.err ? "FAILS " + JSON.stringify(sim.value.err) : `ok (${sim.value.unitsConsumed} CU)`}`);
    if (sim.value.err) {
      (sim.value.logs || []).slice(-6).forEach((l) => console.log("   " + l));
      console.log("   (InstructionFallbackNotFound / 0x65 = the deployed program does not have update_token_uri yet)");
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
    const n = num(m);
    process.stdout.write(`#${String(n).padStart(3)} … `);
    let sig;
    try {
      sig = await sendAndConfirmTransaction(c, buildTx(kp.publicKey, m, want), [kp], { commitment: "confirmed" });
    } catch (e) {
      console.log(`FAILED — ${e.message.split("\n")[0].slice(0, 140)}`);
      failed++; failures.push({ n, error: e.message });
      await sleep(400);
      continue;
    }
    // Read back: uri must be the target, every other field unchanged.
    const after = parseMetadata((await c.getAccountInfo(mdPda(new PublicKey(m.mint)), "confirmed")).data);
    if (after.uri !== want || fingerprint(after) !== fingerprint(m)) {
      console.log(`${sig}\n\nSTOP: post-send check failed for #${n}.`);
      console.log("before:", JSON.stringify(m));
      console.log("after :", JSON.stringify(after));
      process.exit(2);
    }
    console.log(sig);
    sent++;
    await sleep(400);
  }

  console.log(`\nsent: ${sent}   failed: ${failed}`);
  if (failures.length) {
    console.log("failures (re-run the same command to retry only these):");
    failures.slice(0, 20).forEach((f) => console.log(`  #${f.n}  ${f.error.split("\n")[0].slice(0, 100)}`));
    process.exit(1);
  }
  if (!REVERT) console.log(`\nAll sent. Next: node sweep_uri.cjs --map ${MAP_PATH} --verify`);
}

if (require.main === module) main().catch((e) => { console.error("ERR", e.message); process.exit(1); });
module.exports = { parseMetadata, updateTokenUriIx, loadMap, num, fingerprint, DISC, MINT_STATE };
