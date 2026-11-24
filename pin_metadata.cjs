#!/usr/bin/env node
// Pin the 500 RISE Phoenix metadata JSONs (and, once approved, the collection
// image + JSON) to Pinata as bare files, verify each through the x1forge
// gateway, and write uri_map.json for sweep_uri.cjs / lock_metadata.cjs.
//
//   node pin_metadata.cjs                          DRY RUN: validate all 500 files, compute every CIDv0
//                                                  locally, write uri_map.expected.json. No network.
//   node pin_metadata.cjs --token 0 --execute      pin + verify one file (pilot)
//   node pin_metadata.cjs --execute                pin + verify all 500 (resumable)
//   node pin_metadata.cjs --collection --execute   pin + verify collection image and collection JSON
//                                                  (only after the owner approves collection/collection.json)
//
// Numbering: file N-v3.json = on-chain "RISE Phoenix #N" = JSON name "RISE Phoenix #(N+1)" = map key "N".
//
// Lessons carried over from ~/cappy-nft-mint/rewrite-metadata.cjs:
//   * pinFileToIPFS with pinataOptions {cidVersion: 0, wrapWithDirectory: false}: a bare file,
//     so the URI is …/ipfs/<Qm> with no "/N.json" path and no directory CID.
//   * pinataMetadata.name is slash-free ("rise-meta-N.json"); a "/" in the name makes Pinata
//     treat the upload as a directory.
//   * JWT read from ~/.config/pinata/jwt, only with --execute. HTTP 429 → back off and retry.
//   * Resumable state file; re-running only does what is left.
// Added here:
//   * The EXACT bytes of N-v3.json are uploaded (no re-serialising), so the pinned JSON equals
//     what Vercel serves from /metadata/N-v3.json byte for byte.
//   * Every CIDv0 is computed locally first; Pinata's IpfsHash must equal it.
//   * Every pin is fetched back with GET from https://ipfs.x1forge.xyz/ipfs/<Qm>; the body's
//     sha256 must equal the local file's. Only verified entries go into uri_map.json.
//
// Options: --dir <metadata dir> (default ~/rise-phoenix-nft/public/metadata), --out <uri_map.json>,
//          --collection-dir <dir> (default ./collection), --gateway <https://…/ipfs/>

const fs = require("fs"), os = require("os"), path = require("path"), crypto = require("crypto");
const { EXTERNAL_URL } = require("./rise_meta_common.cjs"); // owner decision 2026-11-24: x1forge's RISE collection page

const UPLOAD_ENDPOINT = "https://api.pinata.cloud/pinning/pinFileToIPFS";
const JWT_PATH = path.join(os.homedir(), ".config", "pinata", "jwt");
const MAX_RETRIES = 4, DELAY_MS = 300, VERIFY_TRIES = 6;
const N_TOKENS = 500;
const CHUNK = 262144; // IPFS default chunker: files up to 256 KiB are a single dag-pb node

// ── CIDv0 of a single-chunk file (what `ipfs add --cid-version 0` gives) ──
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58(buf) {
  let n = BigInt("0x" + (buf.toString("hex") || "0")), s = "";
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of buf) { if (b !== 0) break; s = "1" + s; }
  return s;
}
function varint(n) { const out = []; while (n >= 0x80) { out.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } out.push(n); return Buffer.from(out); }
function cidV0(bytes) {
  if (!bytes.length) throw new Error("empty file"); // UnixFS encodes empty files differently; never pin one
  if (bytes.length > CHUNK) throw new Error(`${bytes.length} B is over one ${CHUNK} B chunk; compute its CID with ipfs add -n`);
  // UnixFS Data { Type = File(2), Data = bytes, filesize = len }
  const unixfs = Buffer.concat([Buffer.from([0x08, 0x02]), Buffer.from([0x12]), varint(bytes.length), bytes, Buffer.from([0x18]), varint(bytes.length)]);
  // dag-pb PBNode { Data = unixfs } (no links)
  const node = Buffer.concat([Buffer.from([0x0a]), varint(unixfs.length), unixfs]);
  const digest = crypto.createHash("sha256").update(node).digest();
  return b58(Buffer.concat([Buffer.from([0x12, 0x20]), digest]));
}
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");

// ── validation of one member file ─────────────────────────────────────
function checkMemberFile(n, bytes, GATEWAY = "https://ipfs.x1forge.xyz/ipfs/") {
  const p = [];
  let j;
  try { j = JSON.parse(bytes.toString("utf8")); } catch (e) { return [`not JSON: ${e.message}`]; }
  if (j.name !== `RISE Phoenix #${n + 1}`) p.push(`name ${JSON.stringify(j.name)}, want "RISE Phoenix #${n + 1}"`);
  const numAttr = (j.attributes || []).find((a) => a && a.trait_type === "Number");
  if (!numAttr || numAttr.value !== n + 1) p.push(`attribute Number ${JSON.stringify(numAttr && numAttr.value)}, want ${n + 1}`);
  if (j.symbol !== "RISE") p.push(`symbol ${JSON.stringify(j.symbol)}`);
  if (j.external_url !== EXTERNAL_URL) p.push(`external_url ${JSON.stringify(j.external_url)}, want ${JSON.stringify(EXTERNAL_URL)}`);
  if (typeof j.image !== "string" || !j.image.startsWith(GATEWAY)) p.push(`image not on ${GATEWAY}: ${j.image}`);
  const f0 = j.properties && j.properties.files && j.properties.files[0];
  if (!f0 || f0.uri !== j.image) p.push("properties.files[0].uri != image");
  const text = bytes.toString("utf8").toLowerCase();
  for (const bad of ["lighthouse", "vercel.app/api", "gateway.pinata.cloud"]) if (text.includes(bad)) p.push(`mentions ${bad}`);
  return p;
}

// ── Pinata ────────────────────────────────────────────────────────────
let jwt = null;
let GATEWAY = "https://ipfs.x1forge.xyz/ipfs/";
async function upload(bytes, name, type, keyvalues) {
  const body = new FormData();
  body.append("file", new Blob([bytes], { type }), name);
  body.append("pinataMetadata", JSON.stringify({ name, keyvalues }));
  body.append("pinataOptions", JSON.stringify({ cidVersion: 0, wrapWithDirectory: false }));
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(UPLOAD_ENDPOINT, { method: "POST", headers: { Authorization: `Bearer ${jwt}` }, body, signal: AbortSignal.timeout(60000) });
      const text = await res.text();
      if (res.ok) return JSON.parse(text).IpfsHash;
      if (res.status === 429) { await sleep(2000 * attempt); continue; }
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    } catch (e) {
      if (attempt === MAX_RETRIES) throw e;
      await sleep(1000 * attempt);
    }
  }
  throw new Error(`gave up after ${MAX_RETRIES} retries`);
}
// GET through the gateway; body sha256 must equal the local file's.
async function verifyOnGateway(cid, wantSha) {
  let last = "";
  for (let i = 1; i <= VERIFY_TRIES; i++) {
    try {
      const res = await fetch(GATEWAY + cid, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(30000) });
      if (res.ok) {
        const body = Buffer.from(await res.arrayBuffer());
        if (sha256(body) === wantSha) return true;
        last = `body sha256 ${sha256(body).slice(0, 12)}… != local ${wantSha.slice(0, 12)}…`;
      } else last = `HTTP ${res.status}`;
    } catch (e) { last = e.message; }
    await sleep(1500 * i);
  }
  throw new Error(`gateway verify failed for ${cid}: ${last}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One pin = upload (unless the state says done) + gateway verify.
async function pinOne(key, bytes, name, type, state) {
  const expected = cidV0(bytes), wantSha = sha256(bytes);
  if (state[key] && state[key].verified && state[key].cid === expected) return expected;
  const cid = await upload(bytes, name, type, { collection: "rise-phoenix", item: String(key) });
  if (cid !== expected) throw new Error(`Pinata returned ${cid}, local CIDv0 is ${expected} (cidVersion/wrapping wrong?)`);
  state[key] = { cid, sha256: wantSha, uploaded: new Date().toISOString(), verified: false };
  await verifyOnGateway(cid, wantSha);
  state[key].verified = true;
  return cid;
}

async function main() {
  // ── args ──────────────────────────────────────────────────────────────
  const argv = process.argv.slice(2);
  const known = new Set(["--execute", "--collection", "--token", "--dir", "--out", "--collection-dir", "--gateway"]);
  for (let i = 0; i < argv.length; i++) {
    if (!known.has(argv[i])) { console.error(`unknown argument ${argv[i]}`); process.exit(1); }
    if (!["--execute", "--collection"].includes(argv[i])) {
      if (argv[i + 1] === undefined || argv[i + 1].startsWith("--")) { console.error(`${argv[i]} needs a value`); process.exit(1); }
      i++;
    }
  }
  const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
  const EXECUTE = argv.includes("--execute");
  const COLLECTION = argv.includes("--collection");
  const TOKEN = opt("--token", null);
  if (TOKEN !== null && !(/^\d+$/.test(TOKEN) && +TOKEN < N_TOKENS)) { console.error("--token must be 0..499"); process.exit(1); }
  if (TOKEN !== null && COLLECTION) { console.error("--token and --collection are exclusive"); process.exit(1); }
  const DIR = opt("--dir", path.join(os.homedir(), "rise-phoenix-nft", "public", "metadata"));
  const OUT = opt("--out", path.join(__dirname, "uri_map.json"));
  const COLL_DIR = opt("--collection-dir", path.join(__dirname, "collection"));
  GATEWAY = opt("--gateway", GATEWAY);
  if (!/^https:\/\/[^/]+\/ipfs\/$/.test(GATEWAY)) { console.error("--gateway must look like https://host/ipfs/"); process.exit(1); }
  const STATE = OUT.replace(/\.json$/, "") + ".state.json";

  console.log(`dir     : ${DIR}\nout     : ${OUT}\ngateway : ${GATEWAY}`);
  console.log(`mode    : ${EXECUTE ? "EXECUTE — uploads to Pinata" : "DRY RUN — no network, nothing uploaded"}`);
  console.log(`scope   : ${COLLECTION ? "collection image + JSON" : TOKEN !== null ? `file ${TOKEN}-v3.json` : "files 0..499"}\n`);

  let state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : {};
  const save = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
  if (EXECUTE) {
    try { jwt = fs.readFileSync(JWT_PATH, "utf8").trim(); } catch { console.error(`Could not read JWT from ${JWT_PATH}`); process.exit(1); }
  }

  // ── collection ──
  if (COLLECTION) {
    const imgPath = path.join(COLL_DIR, "collection.jpg"), jsonPath = path.join(COLL_DIR, "collection.json");
    const img = fs.readFileSync(imgPath), json = fs.readFileSync(jsonPath);
    const imgCid = cidV0(img), j = JSON.parse(json.toString("utf8"));
    const p = [];
    if (j.name !== "RISE Phoenix") p.push(`name ${JSON.stringify(j.name)}`);
    if (j.external_url !== EXTERNAL_URL) p.push(`external_url ${JSON.stringify(j.external_url)}, want ${JSON.stringify(EXTERNAL_URL)}`);
    if (j.image !== GATEWAY + imgCid) p.push(`image ${j.image} != ${GATEWAY + imgCid} (CIDv0 of ${imgPath})`);
    if (!j.properties || !j.properties.files || j.properties.files[0].uri !== j.image) p.push("properties.files[0].uri != image");
    if (p.length) { console.error("collection.json rejected:\n  " + p.join("\n  ")); process.exit(1); }
    console.log(`collection image ${imgCid}  (${img.length} B)\ncollection json  ${cidV0(json)}  → ${GATEWAY}${cidV0(json)}`);
    if (!EXECUTE) { console.log("\nDry run. Add --execute to pin both."); return; }
    try {
      await pinOne("collection-image", img, "rise-collection.jpg", "image/jpeg", state); save();
      const cid = await pinOne("collection", json, "rise-collection.json", "application/json", state); save();
      const map = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : {};
      map.collection = GATEWAY + cid;
      fs.writeFileSync(OUT, JSON.stringify(map, null, 2) + "\n");
      console.log(`\npinned + verified. ${OUT}: "collection": "${map.collection}"`);
    } catch (e) { save(); console.error("FAILED:", e.message); process.exit(1); }
    return;
  }

  // ── members ──
  const tokens = TOKEN !== null ? [+TOKEN] : [...Array(N_TOKENS).keys()];
  const files = {};
  const problems = [];
  const cids = new Map();
  for (const n of tokens) {
    const f = path.join(DIR, `${n}-v3.json`);
    if (!fs.existsSync(f)) { problems.push(`${n}: ${f} missing`); continue; }
    const bytes = fs.readFileSync(f);
    problems.push(...checkMemberFile(n, bytes, GATEWAY).map((x) => `${n}-v3.json: ${x}`));
    const cid = cidV0(bytes);
    if (cids.has(cid)) problems.push(`${n}-v3.json: same CID as ${cids.get(cid)}-v3.json`);
    cids.set(cid, n);
    files[n] = { bytes, cid };
  }
  if (problems.length) { console.error(`${problems.length} problem(s):\n  ` + problems.slice(0, 40).join("\n  ")); process.exit(1); }
  console.log(`${tokens.length} file(s) valid: name #(N+1), Number N+1, external_url ${EXTERNAL_URL}, image on ${GATEWAY}, distinct CIDs`);
  for (const n of tokens.slice(0, 3)) console.log(`  ${n}-v3.json  ${files[n].cid}  → map "${n}": "${GATEWAY}${files[n].cid}"`);

  if (!EXECUTE) {
    const expected = {};
    for (const n of tokens) expected[String(n)] = GATEWAY + files[n].cid;
    const ef = OUT.replace(/\.json$/, "") + ".expected.json";
    fs.writeFileSync(ef, JSON.stringify(expected, null, 2) + "\n");
    console.log(`\nwrote ${ef} (what uri_map.json will contain once every pin verifies)`);
    console.log("Dry run. Nothing uploaded. Add --execute (try --token 0 first).");
    return;
  }

  let done = 0, failed = 0;
  const failures = [];
  for (const n of tokens) {
    process.stdout.write(`${String(n).padStart(3)}-v3.json ${files[n].cid} … `);
    try {
      await pinOne(String(n), files[n].bytes, `rise-meta-${n}.json`, "application/json", state);
      console.log("pinned + verified");
      done++;
    } catch (e) {
      console.log(`FAILED — ${e.message}`);
      failed++; failures.push({ n, error: e.message });
    }
    if ((done + failed) % 10 === 0) save();
    await sleep(DELAY_MS);
  }
  save();

  // uri_map.json: verified entries only, keeping any existing "collection" key.
  const map = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : {};
  for (let n = 0; n < N_TOKENS; n++) {
    const s = state[String(n)];
    if (s && s.verified) map[String(n)] = GATEWAY + s.cid; else delete map[String(n)];
  }
  const ordered = {};
  for (let n = 0; n < N_TOKENS; n++) if (map[String(n)]) ordered[String(n)] = map[String(n)];
  if (map.collection) ordered.collection = map.collection;
  fs.writeFileSync(OUT, JSON.stringify(ordered, null, 2) + "\n");
  const have = Object.keys(ordered).filter((k) => k !== "collection").length;
  console.log(`\npinned + verified this run: ${done}, failed: ${failed}. ${OUT} now has ${have}/500 members${ordered.collection ? " + collection" : ""}.`);
  if (failures.length) { failures.slice(0, 20).forEach((f) => console.log(`  ${f.n}: ${f.error}`)); console.log("Re-run to retry only these."); process.exit(1); }
}

if (require.main === module) main().catch((e) => { console.error("ERR", e.message); process.exit(1); });
module.exports = { cidV0, checkMemberFile };
