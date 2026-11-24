// Shared helpers for sweep_uri.cjs and lock_metadata.cjs (RISE Phoenix, X1 mainnet).
// Pure functions plus read-only RPC helpers. Nothing here signs or sends.
//
// Numbering, everywhere in these scripts:
//   on-chain name "RISE Phoenix #N"  (N = 0..499)
//   = file ~/rise-phoenix-nft/public/metadata/N-v3.json
//   = Vercel https://rise-phoenix-nft.vercel.app/api/metadata/N
//   = JSON "name": "RISE Phoenix #(N+1)" and attribute Number = N+1
//   = uri_map.json key "N"

const { PublicKey } = require("@solana/web3.js");

const DEFAULT_RPC = "https://rpc.mainnet.x1.xyz";
const DEFAULT_PROGRAM = "5QUVVnm1duiRazqa69KW9ZQhCCZcg5GBUKkUn5avA8Gb";
const MPL = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const OLD_BASE = "https://rise-phoenix-nft.vercel.app/api/metadata/"; // BASE_URI of the old program
const OLD_HOST = "rise-phoenix-nft.vercel.app";
const MAX_URI_LENGTH = 200; // Metaplex limit, also enforced on-chain (UriTooLong 6005)
const EXPECTED_MEMBERS = 500;
// Parent collection NFT. Read from chain 2026-11-24: update authority = mint_state,
// uri = OLD_BASE + "0" (member #0's JSON), sized collection, size 500.
const COLLECTION_MINT = "hzdZak4qN9bZ93ztu4bTBmDwx6F3XNyieFG5SQqCsJm";
const COLLECTION_METADATA = "FRN2yo3JLHV3ZXqcwsAgxRcDu2YFTQjvjT4cg35J6inR";
const COLLECTION_KEY = "collection"; // uri_map.json key for the collection NFT
const COLLECTION_OLD_URI = OLD_BASE + "0";

const mdPda = (mint) =>
  PublicKey.findProgramAddressSync([Buffer.from("metadata"), MPL.toBuffer(), new PublicKey(mint).toBuffer()], MPL)[0];
const mintStatePda = (program) => PublicKey.findProgramAddressSync([Buffer.from("mint_state_v2")], new PublicKey(program))[0];

// ── Strict argument parser ─────────────────────────────────────────────
// spec = { flags: ["--send", ...], opts: { "--token": validatorFn, ... } }
// Unknown arguments, a missing value, or a value that fails its validator → throws.
function parseArgs(argv, spec) {
  const out = { flags: new Set(), opts: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (spec.flags.includes(a)) { out.flags.add(a); continue; }
    if (a in spec.opts) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
      const err = spec.opts[a](v);
      if (err) throw new Error(`${a} ${JSON.stringify(v)}: ${err}`);
      if (a in out.opts) throw new Error(`${a} given twice`);
      out.opts[a] = v;
      i++;
      continue;
    }
    throw new Error(`unknown argument ${JSON.stringify(a)}`);
  }
  return out;
}
const V = {
  tokenNumber: (v) => (/^\d+$/.test(v) && +v < EXPECTED_MEMBERS ? null : `must be an integer 0..${EXPECTED_MEMBERS - 1}`),
  positiveInt: (v) => (/^[1-9]\d*$/.test(v) ? null : "must be a positive integer"),
  nonNegInt: (v) => (/^\d+$/.test(v) ? null : "must be a non-negative integer"),
  pubkey: (v) => { try { new PublicKey(v); return null; } catch { return "is not a public key"; } },
  url: (v) => (/^https?:\/\/\S+$/.test(v) ? null : "must be an http(s) URL"),
  any: (v) => (v.length ? null : "must not be empty"),
};

// ── Metaplex metadata parsing (full layout) ─────────────────────────────
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
  // collection_details + programmable_config + padding: compared as raw bytes
  const tail = d.slice(o).toString("hex");
  return { key, ua, mint, name, symbol, uri, fee, creators, primarySaleHappened, isMutable, editionNonce, tokenStandard, collection, uses, tail };
}
const num = (m) => { const x = /^RISE Phoenix #(\d+)$/.exec(m.name); return x ? +x[1] : -1; };
// Every parsed field except the ones named, as a stable string.
const fingerprint = (m, ...ignore) => { const c = { ...m }; for (const k of ignore) delete c[k]; return JSON.stringify(c); };
const isMember = (m, mintState) =>
  m.ua === mintState && num(m) >= 0 && !!m.collection && m.collection.verified && m.collection.key === COLLECTION_MINT;

// ── Discovery (finding S2) ──────────────────────────────────────────────
// Keep only metadata whose collection is VERIFIED and equals COLLECTION_MINT.
// Verifying needs the collection authority (mint_state) to sign, so a stranger
// cannot fake one. Then require exactly 500, numbered 0..499 with no gaps.
async function discover(c, mintState) {
  const ms = mintState.toBase58();
  const accs = await c.getProgramAccounts(MPL, { filters: [{ memcmp: { offset: 1, bytes: ms } }] });
  const all = accs.map((a) => ({ pda: a.pubkey.toBase58(), ...parseMetadata(a.account.data) }));
  const members = all.filter((m) => isMember(m, ms)).sort((a, b) => num(a) - num(b));
  const ignored = all.filter((m) => !isMember(m, ms) && m.pda !== COLLECTION_METADATA);
  const nums = members.map(num);
  const problems = [];
  if (members.length !== EXPECTED_MEMBERS) problems.push(`found ${members.length} verified members of ${COLLECTION_MINT}, expected exactly ${EXPECTED_MEMBERS}`);
  const want = new Set([...Array(EXPECTED_MEMBERS).keys()]);
  const dupes = nums.filter((n, i) => nums.indexOf(n) !== i);
  if (dupes.length) problems.push(`duplicate verified token numbers: ${[...new Set(dupes)].join(",")}`);
  const missing = [...want].filter((n) => !nums.includes(n));
  if (missing.length) problems.push(`missing token numbers: ${missing.slice(0, 20).join(",")}`);
  for (const m of members) if (m.pda !== mdPda(m.mint).toBase58()) problems.push(`#${num(m)} metadata ${m.pda} is not the PDA of mint ${m.mint}`);
  const collAcc = await c.getAccountInfo(new PublicKey(COLLECTION_METADATA));
  let collection = null;
  if (!collAcc) problems.push(`collection metadata ${COLLECTION_METADATA} not found`);
  else {
    collection = { pda: COLLECTION_METADATA, ...parseMetadata(collAcc.data) };
    if (collection.mint !== COLLECTION_MINT) problems.push(`collection metadata mint is ${collection.mint}`);
    if (collection.ua !== ms) problems.push(`collection update authority is ${collection.ua}, not mint_state`);
    if (mdPda(COLLECTION_MINT).toBase58() !== COLLECTION_METADATA) problems.push("COLLECTION_METADATA is not the PDA of COLLECTION_MINT");
  }
  if (problems.length) throw new Error("discovery failed:\n  " + problems.join("\n  "));
  return { members, collection, ignored };
}

// ── Read-back with retries (finding S6) ─────────────────────────────────
// A load-balanced RPC can briefly return the old account or null right after
// a confirmed send. `landed(m)` says whether the intended change is visible;
// until it is, retry. Once it is, `same(m)` must hold or we stop at once.
async function readBack(c, pda, landed, same, { tries = 6, delayMs = 1500 } = {}) {
  let last = null;
  for (let i = 1; i <= tries; i++) {
    const acc = await c.getAccountInfo(new PublicKey(pda), "confirmed").catch(() => null);
    if (acc) {
      last = parseMetadata(acc.data);
      if (landed(last)) return { ok: same(last), after: last, tries: i };
    }
    if (i < tries) await new Promise((r) => setTimeout(r, delayMs * i));
  }
  return { ok: false, after: last, tries, notLanded: true };
}

// ── uri map ─────────────────────────────────────────────────────────────
// {"0": uri, ..., "499": uri, "collection": uri}. Keys "collection" optional.
function checkMap(raw) {
  const problems = [];
  if (typeof raw !== "object" || Array.isArray(raw) || raw === null) return ['expected a JSON object {"N": "uri"}'];
  const seen = new Map();
  for (const [k, v] of Object.entries(raw)) {
    if (k !== COLLECTION_KEY && (!/^\d+$/.test(k) || +k >= EXPECTED_MEMBERS || String(+k) !== k)) problems.push(`key "${k}": not a token number 0..${EXPECTED_MEMBERS - 1} or "${COLLECTION_KEY}"`);
    if (typeof v !== "string" || v.length === 0) { problems.push(`${k}: empty or non-string uri`); continue; }
    const bytes = Buffer.byteLength(v, "utf8");
    if (bytes > MAX_URI_LENGTH) problems.push(`${k}: uri is ${bytes} bytes, Metaplex limit is ${MAX_URI_LENGTH}`);
    if (v !== v.trim()) problems.push(`${k}: uri has leading/trailing whitespace`);
    if (v.includes(OLD_HOST)) problems.push(`${k}: uri still points at ${OLD_HOST}`);
    // https only: --verify must be able to GET it, and the gateway is what wallets will fetch (S7)
    if (!/^https:\/\//.test(v)) problems.push(`${k}: uri must be https://`);
    if (seen.has(v)) problems.push(`${k}: same uri as ${seen.get(v)}`);
    seen.set(v, k);
  }
  return problems;
}

// Recursive field-for-field diff. Returns a list of "path: a != b".
function jsonDiff(a, b, path = "") {
  if (a === b) return [];
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object" || Array.isArray(a) !== Array.isArray(b))
    return [`${path || "."}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out = [];
  for (const k of keys) out.push(...jsonDiff(a[k], b[k], path ? `${path}.${k}` : k));
  return out;
}

module.exports = {
  DEFAULT_RPC, DEFAULT_PROGRAM, MPL, OLD_BASE, OLD_HOST, MAX_URI_LENGTH, EXPECTED_MEMBERS,
  COLLECTION_MINT, COLLECTION_METADATA, COLLECTION_KEY, COLLECTION_OLD_URI,
  mdPda, mintStatePda, parseArgs, V, parseMetadata, num, fingerprint, isMember, discover, readBack, checkMap, jsonDiff,
};
