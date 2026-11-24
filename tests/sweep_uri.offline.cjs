// Offline check of sweep_uri.cjs helpers. No network: never calls main().
// Prereqs: `anchor build`, then `cd tests/svm && cargo test --offline` (writes the metadata dumps).
// Run: node tests/sweep_uri.offline.cjs
const assert = require("assert"), fs = require("fs"), path = require("path"), os = require("os");
const repo = path.join(__dirname, "..");
const s = require(path.join(repo, "sweep_uri.cjs"));
const dumps = path.join(repo, "tests/svm/target/metadata-dumps");
const idl = JSON.parse(fs.readFileSync(path.join(repo, "target/idl/rise_phoenix_contract.json")));
const ixIdl = idl.instructions.find((i) => i.name === "update_token_uri");
assert.deepStrictEqual([...s.DISC], ixIdl.discriminator); console.log("discriminator matches IDL", ixIdl.discriminator);
assert.deepStrictEqual(ixIdl.accounts.map((a) => a.name), ["mint_state", "authority", "metadata", "token_metadata_program"]);
assert.strictEqual(s.MINT_STATE.toBase58().length > 30, true);
const before = s.parseMetadata(fs.readFileSync(path.join(dumps, "before.bin")));
const after = s.parseMetadata(fs.readFileSync(path.join(dumps, "after.bin")));
const coll = s.parseMetadata(fs.readFileSync(path.join(dumps, "collection.bin")));
console.log("before:", JSON.stringify(before)); console.log("after :", JSON.stringify(after));
assert.strictEqual(before.uri, "https://rise-phoenix-nft.vercel.app/api/metadata/7");
assert.ok(after.uri.startsWith("https://ipfs.example/"));
assert.strictEqual(s.num(before), 7); assert.strictEqual(s.num(coll), -1, "collection NFT must be excluded");
assert.strictEqual(before.collection.verified, true);
assert.strictEqual(before.collection.key, fs.readFileSync(path.join(dumps, "collection_mint.txt"), "utf8"));
assert.strictEqual(before.creators[0].verified, true);
assert.strictEqual(s.fingerprint(before), s.fingerprint(after), "fingerprint ignores only uri");
const tampered = { ...after, collection: { ...after.collection, verified: false } };
assert.notStrictEqual(s.fingerprint(before), s.fingerprint(tampered), "fingerprint catches an unverified collection");
// instruction encoding
const { PublicKey } = require(path.join(repo, "node_modules/@solana/web3.js"));
const ix = s.updateTokenUriIx(new PublicKey(before.ua), before.mint, "https://a/b");
assert.strictEqual(ix.data.length, 8 + 4 + 11); assert.strictEqual(ix.data.readUInt32LE(8), 11);
assert.deepStrictEqual(ix.keys.map((k) => [k.isSigner, k.isWritable]), [[false, false], [true, false], [false, true], [false, false]]);
// map validation (loadMap exits on failure; run it in a child process per case)
const { spawnSync } = require("child_process");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rise-sweep-map-"));
const tryMap = (obj) => { const f = path.join(tmp, Math.random() + ".json"); fs.writeFileSync(f, JSON.stringify(obj));
  return spawnSync(process.execPath, ["-e", `require(${JSON.stringify(path.join(repo, "sweep_uri.cjs"))}).loadMap(${JSON.stringify(f)}); console.log("accepted")`], { encoding: "utf8" }); };
const good = Object.fromEntries([...Array(500).keys()].map((n) => [n, `https://gw.example/ipfs/bafy${n}/${n}.json`]));
assert.match(tryMap(good).stdout, /accepted/);
for (const [label, bad] of [["empty", { 1: "" }], ["too long", { 1: "https://x/" + "a".repeat(191) }], ["vercel", { 1: "https://rise-phoenix-nft.vercel.app/api/metadata/1" }],
  ["dupe", { 1: "https://x/a", 2: "https://x/a" }], ["key 500", { 500: "https://x/a" }], ["http", { 1: "http://x/a" }]]) {
  const r = tryMap(bad); assert.strictEqual(r.status, 1, label); console.log(`map rejected (${label}): ${r.stderr.split("\n")[1].trim()}`);
}
assert.match(tryMap({ 1: "https://x/" + "a".repeat(190) }).stdout, /accepted/, "200 bytes ok");
// refusal paths that exit before any network call
const run = (args) => spawnSync(process.execPath, [path.join(repo, "sweep_uri.cjs"), ...args], { encoding: "utf8" });
let r = run(["--map", "x.json", "--send"]); assert.strictEqual(r.status, 1); console.log("--send alone:", r.stderr.trim());
r = run([]); assert.strictEqual(r.status, 1); console.log("no --map:", r.stderr.trim());
console.log("\nALL OFFLINE CHECKS PASSED");
