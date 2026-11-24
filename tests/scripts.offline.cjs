// Offline checks for sweep_uri.cjs, lock_metadata.cjs, pin_metadata.cjs, update_royalty.cjs,
// incinerate_collection.cjs and rise_meta_common.cjs. No network: RPC calls go to fake connection objects,
// and refusal paths are exercised only where they exit before any network call.
// Prereqs: `anchor build`, then `cd tests/svm && cargo test --offline` (writes the metadata dumps).
// Run: node tests/scripts.offline.cjs
const assert = require("assert"), fs = require("fs"), path = require("path"), os = require("os");
const { spawnSync } = require("child_process");
const repo = path.join(__dirname, "..");
const { PublicKey, Keypair } = require(path.join(repo, "node_modules/@solana/web3.js"));
const K = require(path.join(repo, "rise_meta_common.cjs"));
const sweep = require(path.join(repo, "sweep_uri.cjs"));
const lockS = require(path.join(repo, "lock_metadata.cjs"));
const pin = require(path.join(repo, "pin_metadata.cjs"));
const roy = require(path.join(repo, "update_royalty.cjs"));
const inc = require(path.join(repo, "incinerate_collection.cjs"));
const mainnetFx = path.join(repo, "tests/svm/fixtures/mainnet");
const dumps = path.join(repo, "tests/svm/target/metadata-dumps");
const idl = JSON.parse(fs.readFileSync(path.join(repo, "target/idl/rise_phoenix_contract.json")));
let n = 0;
const ok = (msg) => { n++; console.log("ok  " + msg); };

// ── IDL: instructions, discriminators, accounts ──
assert.deepStrictEqual(idl.instructions.map((i) => i.name).sort(), ["close_pending_mint", "lock_metadata", "update_royalty", "update_token_uri"]);
for (const [name, d] of [["update_token_uri", sweep.DISC], ["lock_metadata", lockS.DISC]]) {
  const ix = idl.instructions.find((i) => i.name === name);
  assert.deepStrictEqual([...d], ix.discriminator);
  assert.deepStrictEqual(ix.accounts.map((a) => a.name), ["mint_state", "authority", "metadata", "token_metadata_program"]);
}
assert.deepStrictEqual(idl.errors.map((e) => `${e.code}:${e.name}`), ["6000:SoldOut", "6001:RandomnessNotReady", "6002:InvalidRoyalty", "6003:InvalidCreators", "6004:EmptyUri", "6005:UriTooLong"]);
ok("IDL: 4 instructions; update_token_uri/lock_metadata discriminators + accounts match; error codes 6000-6005 unchanged");

// ── instruction encoding ──
const prog = new PublicKey(K.DEFAULT_PROGRAM), ms = K.mintStatePda(prog), auth = Keypair.generate().publicKey, mint = Keypair.generate().publicKey;
assert.strictEqual(ms.toBase58(), "7m8h2Rf5w4UzPqS9EVMVkHwaKhhfvrJiwoc8Qvapkxoh");
let ix = sweep.updateTokenUriIx(prog, ms, auth, mint, "https://a/b");
assert.strictEqual(ix.data.length, 8 + 4 + 11); assert.strictEqual(ix.data.readUInt32LE(8), 11);
assert.deepStrictEqual(ix.keys.map((k) => [k.isSigner, k.isWritable]), [[false, false], [true, false], [false, true], [false, false]]);
assert.ok(ix.keys[2].pubkey.equals(K.mdPda(mint)));
ix = lockS.lockIx(prog, ms, auth, mint);
assert.strictEqual(ix.data.length, 8);
assert.deepStrictEqual(ix.keys.map((k) => [k.isSigner, k.isWritable]), [[false, false], [true, false], [false, true], [false, false]]);
assert.strictEqual(K.mdPda(K.COLLECTION_MINT).toBase58(), K.COLLECTION_METADATA);
ok("instruction encoding; mint_state PDA = 7m8h2Rf5…; collection metadata PDA = FRN2yo3…");

// ── parser + fingerprints on real Metaplex bytes from LiteSVM ──
const P = (f) => K.parseMetadata(fs.readFileSync(path.join(dumps, f)));
const before = P("before.bin"), after = P("after.bin"), coll = P("collection.bin"), lb = P("lock_before.bin"), la = P("lock_after.bin");
assert.strictEqual(before.uri, "https://rise-phoenix-nft.vercel.app/api/metadata/7");
assert.strictEqual(K.num(before), 7); assert.strictEqual(K.num(coll), -1);
assert.strictEqual(K.fingerprint(before, "uri"), K.fingerprint(after, "uri"));
assert.notStrictEqual(K.fingerprint(before, "uri"), K.fingerprint({ ...after, collection: { ...after.collection, verified: false } }, "uri"));
assert.notStrictEqual(K.fingerprint(before, "uri"), K.fingerprint({ ...after, tail: after.tail.replace(/.$/, "f") }, "uri"), "tail bytes are compared");
assert.strictEqual(lb.isMutable, true); assert.strictEqual(la.isMutable, false);
assert.strictEqual(K.fingerprint(lb, "isMutable"), K.fingerprint(la, "isMutable"));
assert.notStrictEqual(K.fingerprint(lb, "isMutable"), K.fingerprint({ ...la, primarySaleHappened: true }, "isMutable"));
ok("parser on real bytes; uri-only and is_mutable-only fingerprints, incl. raw tail bytes");

// ── S4 / S5: strict args ──
const spec = { flags: ["--send"], opts: { "--token": K.V.tokenNumber, "--limit": K.V.positiveInt } };
for (const [args, re] of [[["--limit", "abc"], /positive integer/], [["--limit"], /needs a value/], [["--limit", "--send"], /needs a value/], [["--limit", "0"], /positive/],
  [["--token", ""], /0\.\.499/], [["--token", "500"], /0\.\.499/], [["--token", "7a"], /0\.\.499/], [["--token", "-1"], /needs a value|0\.\.499/], [["--confirm-mainet"], /unknown/], [["--token", "1", "--token", "2"], /twice/]])
  assert.throws(() => K.parseArgs(args, spec), re, JSON.stringify(args));
assert.deepStrictEqual(K.parseArgs(["--token", "0", "--limit", "5", "--send"], spec).opts, { "--token": "0", "--limit": "5" });
ok("S4/S5: --limit abc/0/missing, --token \"\"/500/7a, typos and repeats all refused");

// ── map validation ──
const good = Object.fromEntries([...Array(500).keys()].map((i) => [i, `https://ipfs.x1forge.xyz/ipfs/Qm${String(i).padStart(44, "x")}`]));
assert.deepStrictEqual(K.checkMap(good), []);
assert.deepStrictEqual(K.checkMap({ ...good, collection: "https://ipfs.x1forge.xyz/ipfs/QmCollection" }), []);
for (const [label, bad] of [["empty", { 1: "" }], ["201 bytes", { 1: "https://x/" + "a".repeat(191) }], ["vercel", { 1: "https://rise-phoenix-nft.vercel.app/api/metadata/1" }],
  ["dupe", { 1: "https://x/a", 2: "https://x/a" }], ["key 500", { 500: "https://x/a" }], ["key 07", { "07": "https://x/a" }], ["http", { 1: "http://x/a" }], ["ipfs://", { 1: "ipfs://Qm" }], ["space", { 1: " https://x/a" }], ["array", []]])
  assert.ok(K.checkMap(bad).length > 0, label);
assert.deepStrictEqual(K.checkMap({ 1: "https://x/" + "a".repeat(190) }), [], "200 bytes ok");
ok("map: https only, ≤200 B, no Vercel, no dupes, keys 0..499 or \"collection\"");

// ── S1: JSON numbering + field-for-field compare ──
const metaDir = path.join(os.homedir(), "rise-phoenix-nft/public/metadata");
if (fs.existsSync(path.join(metaDir, "7-v3.json"))) {
  const j7 = JSON.parse(fs.readFileSync(path.join(metaDir, "7-v3.json")));
  assert.deepStrictEqual(sweep.checkMemberJson(7, j7), [], "on-chain #7 = file 7 = JSON #8");
  assert.ok(sweep.checkMemberJson(6, j7).length === 2, "a map shifted by one is caught (name + Number)");
  assert.ok(sweep.checkMemberJson(8, j7).length === 2);
  assert.deepStrictEqual(pin.checkMemberFile(7, fs.readFileSync(path.join(metaDir, "7-v3.json"))), []);
  assert.ok(pin.checkMemberFile(8, fs.readFileSync(path.join(metaDir, "7-v3.json"))).length > 0);
  ok("S1: on-chain #N needs JSON \"RISE Phoenix #(N+1)\" and Number N+1; shifted maps fail");
} else console.log("skip S1 file checks: ~/rise-phoenix-nft not present");
const vj = { name: "RISE Phoenix #8", image: "https://a/x", attributes: [{ trait_type: "Palette", value: "Inferno" }], properties: { files: [{ uri: "https://a/x" }] } };
assert.deepStrictEqual(K.jsonDiff(vj, JSON.parse(JSON.stringify(vj))), []);
const d = K.jsonDiff(vj, { ...vj, image: "https://b/y", attributes: [{ trait_type: "Palette", value: "Magma" }], extra: 1 });
assert.deepStrictEqual(d.map((x) => x.split(":")[0]).sort(), ["attributes.0.value", "extra", "image"]);
ok("S1: jsonDiff reports every differing path (image, nested attribute, added key)");

// ── S2: discovery keeps only verified members of hzdZak4…, exactly 500 ──
function encMd({ ua, mint, name, uri, fee = 100, creators, coll, isMutable = true }) {
  const s = (x, pad) => { const b = Buffer.alloc(4 + pad); const t = Buffer.from(x); b.writeUInt32LE(pad); t.copy(b, 4); return b; };
  const parts = [Buffer.from([4]), new PublicKey(ua).toBuffer(), new PublicKey(mint).toBuffer(), s(name, 32), s("RISE", 10), s(uri, 200)];
  const f = Buffer.alloc(2); f.writeUInt16LE(fee); parts.push(f);
  const cr = creators || [{ address: "Gowv5PDb7K4a5PwjubWegvBT4CDfjjJcG4QAZWa9yUob", verified: true, share: 100 }];
  const l = Buffer.alloc(4); l.writeUInt32LE(cr.length); parts.push(Buffer.from([1]), l);
  for (const c of cr) parts.push(new PublicKey(c.address).toBuffer(), Buffer.from([c.verified ? 1 : 0, c.share]));
  parts.push(Buffer.from([0, isMutable ? 1 : 0, 1, 255, 1, 0]));
  parts.push(coll ? Buffer.concat([Buffer.from([1, coll.verified ? 1 : 0]), new PublicKey(coll.key).toBuffer()]) : Buffer.from([0]));
  parts.push(Buffer.from([0, 0, 0]));
  return Buffer.concat(parts);
}
const MS = ms.toBase58();
const members = [...Array(500).keys()].map((i) => { const m = Keypair.generate().publicKey.toBase58(); return { pubkey: K.mdPda(m), account: { data: encMd({ ua: MS, mint: m, name: `RISE Phoenix #${i}`, uri: K.OLD_BASE + i, coll: { verified: true, key: K.COLLECTION_MINT } }) } }; });
const collAcc = { data: encMd({ ua: MS, mint: K.COLLECTION_MINT, name: "RISE Phoenix", uri: K.COLLECTION_OLD_URI, coll: null }) };
const spoof = (name, coll) => { const m = Keypair.generate().publicKey.toBase58(); return { pubkey: K.mdPda(m), account: { data: encMd({ ua: MS, mint: m, name, uri: "https://evil/x", coll }) } }; };
const spoofs = [spoof("RISE Phoenix #7", null), spoof("RISE Phoenix #7", { verified: false, key: K.COLLECTION_MINT }), spoof("RISE Phoenix #8", { verified: true, key: Keypair.generate().publicKey.toBase58() })];
const fakeConn = (list) => ({ getProgramAccounts: async () => list, getAccountInfo: async (k) => (k.toBase58() === K.COLLECTION_METADATA ? collAcc : null) });
(async () => {
  const r = await K.discover(fakeConn([...members, ...spoofs]), ms);
  assert.strictEqual(r.members.length, 500); assert.strictEqual(r.ignored.length, 3);
  assert.deepStrictEqual(r.members.map(K.num), [...Array(500).keys()]);
  assert.strictEqual(r.collection.name, "RISE Phoenix");
  await assert.rejects(K.discover(fakeConn(members.slice(1)), ms), /found 499.*\n.*missing token numbers: 0/s);
  await assert.rejects(K.discover(fakeConn([...members, members[7]]), ms), /found 501/);
  ok("S2: 3 spoofed '#7/#8' accounts (no / unverified / foreign collection) ignored; 499 or 501 refused");

  // ── S6: read-back retries until the change is visible ──
  const seq = (arr) => { let i = 0; return { getAccountInfo: async () => arr[Math.min(i++, arr.length - 1)] } };
  const oldAcc = members[7].account, newData = encMd({ ua: MS, mint: K.parseMetadata(oldAcc.data).mint, name: "RISE Phoenix #7", uri: "https://ipfs.x1forge.xyz/ipfs/QmNew", coll: { verified: true, key: K.COLLECTION_MINT } });
  const m7 = K.parseMetadata(oldAcc.data);
  const landed = (x) => x.uri === "https://ipfs.x1forge.xyz/ipfs/QmNew", same = (x) => K.fingerprint(x, "uri") === K.fingerprint(m7, "uri");
  let rb = await K.readBack(seq([null, oldAcc, { data: newData }]), K.mdPda(m7.mint), landed, same, { tries: 5, delayMs: 1 });
  assert.deepStrictEqual([rb.ok, rb.tries], [true, 3]);
  rb = await K.readBack(seq([null, oldAcc]), K.mdPda(m7.mint), landed, same, { tries: 3, delayMs: 1 });
  assert.deepStrictEqual([rb.ok, rb.notLanded], [false, true]);
  const badData = encMd({ ua: MS, mint: m7.mint, name: "RISE Phoenix #7", uri: "https://ipfs.x1forge.xyz/ipfs/QmNew", fee: 500, coll: { verified: true, key: K.COLLECTION_MINT } });
  rb = await K.readBack(seq([{ data: badData }]), K.mdPda(m7.mint), landed, same, { tries: 3, delayMs: 1 });
  assert.deepStrictEqual([rb.ok, rb.tries, rb.notLanded], [false, 1, undefined]);
  ok("S6: read-back retries past null/stale reads; stops at once if another field changed");

  // ── lock gates (owner decision: 300 bps + GZuB verified, members AND collection; no override) ──
  assert.strictEqual(K.FINAL_BPS, 300); assert.strictEqual(K.FINAL_CREATOR, "GZuBHE3fQCQ6eSTLMwWKrK15CjtWfA58BmxdtWwG5mJJ");
  const FIN = [{ address: K.FINAL_CREATOR, verified: true, share: 100 }], NEWU = "https://ipfs.x1forge.xyz/ipfs/QmNew";
  const mm = (o) => K.parseMetadata(encMd({ ua: MS, mint: m7.mint, name: "RISE Phoenix #7", uri: NEWU, fee: 300, creators: FIN, coll: { verified: true, key: K.COLLECTION_MINT }, ...o }));
  const G = (m, wantUri = NEWU, isCollection = false) => lockS.gate(m, { isCollection, wantUri });
  assert.deepStrictEqual(G(mm({})), []);
  assert.ok(G(mm({}), "https://ipfs.x1forge.xyz/ipfs/QmOther").length === 1, "uri != map");
  assert.ok(G(mm({ uri: K.OLD_BASE + 7 }), K.OLD_BASE + 7).some((x) => /vercel/.test(x)), "still on Vercel");
  assert.ok(G(mm({ fee: 500, creators: [{ address: MS, verified: true, share: 100 }] })).length === 2, "the 283 shape");
  assert.ok(G(mm({ fee: 100, creators: [{ address: K.OLD_TREASURY, verified: true, share: 100 }] })).length === 2, "the 217 shape (old 1% target) is now refused");
  assert.ok(G(mm({ creators: [{ address: K.FINAL_CREATOR, verified: false, share: 100 }] })).length === 1, "unverified GZuB");
  assert.ok(G(mm({ fee: 100 })).length === 1, "bps only");
  const collM = (o) => K.parseMetadata(encMd({ ua: MS, mint: K.COLLECTION_MINT, name: "RISE Phoenix", uri: "https://ipfs.x1forge.xyz/ipfs/QmC", fee: 300, creators: FIN, ...o }));
  assert.deepStrictEqual(G(collM({}), "https://ipfs.x1forge.xyz/ipfs/QmC", true), []);
  assert.ok(G(collM({ fee: 500, creators: [{ address: MS, verified: true, share: 100 }] }), "https://ipfs.x1forge.xyz/ipfs/QmC", true).length === 2, "collection royalty is gated now (L3)");
  ok("lock gates: uri == map, off Vercel; members AND collection need 300 bps + [GZuB:100 verified]");

  // ── royalty plan on REAL bytes: mainnet accounts (before) and LiteSVM on X1 Metaplex (after) ──
  const R = (f) => K.parseMetadata(fs.readFileSync(f));
  const b283 = R(path.join(mainnetFx, "member0_283_mintstate.bin")), b217 = R(path.join(mainnetFx, "member1_217_gowv5.bin")), bColl = R(path.join(mainnetFx, "collection_FRN2yo3.bin"));
  const strip = (p) => ({ unverify: p.unverify, update: p.update, sign: p.sign, blocked: p.blocked });
  assert.deepStrictEqual(strip(K.royaltyPlan(b283, MS)), { unverify: [], update: true, sign: true, blocked: null });
  assert.deepStrictEqual(strip(K.royaltyPlan(b217, MS)), { unverify: [K.OLD_TREASURY], update: true, sign: true, blocked: null });
  assert.deepStrictEqual(strip(K.royaltyPlan(bColl, MS)), { unverify: [], update: true, sign: true, blocked: null });
  for (const f of ["royalty_283_after.bin", "royalty_217_after.bin", "royalty_collection_after.bin", "royalty_217_locked.bin"]) {
    const a = R(path.join(dumps, f));
    assert.ok(K.royaltyIsFinal(a) && K.royaltyPlan(a, MS).done, f);
    assert.ok(!lockS.gate(a, { isCollection: f.includes("collection"), wantUri: a.uri }).some((x) => /royalty|creators/.test(x)), f + " passes the lock royalty gate");
  }
  assert.strictEqual(K.fingerprint(b217, "fee", "creators"), K.fingerprint(R(path.join(dumps, "royalty_217_after.bin")), "fee", "creators"), "read-back comparator: only fee/creators differ");
  assert.strictEqual(K.fingerprint(bColl, "fee", "creators"), K.fingerprint(R(path.join(dumps, "royalty_collection_after.bin")), "fee", "creators"));
  assert.ok(lockS.gate(b283, { isCollection: false, wantUri: b283.uri }).length >= 2 && lockS.gate(b217, { isCollection: false, wantUri: b217.uri }).length >= 2);
  assert.ok(K.royaltyPlan({ ...b217, isMutable: false }, MS).blocked.includes("locked"), "locked and not final: blocked");
  const stranger = Keypair.generate().publicKey.toBase58();
  assert.ok(K.royaltyPlan({ ...b217, creators: [{ address: stranger, verified: true, share: 100 }] }, MS).blocked.includes(stranger), "unknown verified creator: blocked");
  assert.deepStrictEqual(strip(K.royaltyPlan({ ...b217, fee: 300, creators: [{ address: K.FINAL_CREATOR, verified: false, share: 100 }] }, MS)), { unverify: [], update: false, sign: true, blocked: null }, "sign only");
  assert.deepStrictEqual(strip(K.royaltyPlan({ ...b217, fee: 100, creators: [{ address: K.FINAL_CREATOR, verified: true, share: 100 }] }, MS)), { unverify: [], update: true, sign: false, blocked: null }, "bps only: GZuB keeps its flag");
  ok("royalty plan on real bytes: 283 → update+sign, 217 → unverify Gowv5+update+sign, collection → update+sign; LiteSVM results are final");

  // ── update_royalty.cjs instruction bytes (same as tests/svm/tests/royalty_final.rs) ──
  const m217 = { ...b217, pda: K.mdPda(b217.mint).toBase58() };
  const ixs = roy.royaltyIxs(prog, ms, auth, m217, K.royaltyPlan(b217, MS));
  assert.deepStrictEqual(ixs.map((x) => x.programId.toBase58()), [K.MPL.toBase58(), prog.toBase58(), K.MPL.toBase58()]);
  assert.deepStrictEqual([...ixs[0].data], [28]); assert.deepStrictEqual([...ixs[2].data], [7]);
  assert.deepStrictEqual(ixs[0].keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]), [[m217.pda, false, true], [K.OLD_TREASURY, true, false]]);
  assert.deepStrictEqual(ixs[2].keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]), [[m217.pda, false, true], [K.FINAL_CREATOR, true, false]]);
  const idlRoy = idl.instructions.find((i) => i.name === "update_royalty");
  assert.deepStrictEqual([...roy.DISC], idlRoy.discriminator);
  assert.strictEqual(ixs[1].data.toString("hex"), roy.DISC.toString("hex") + "2c01" + "01000000" + new PublicKey(K.FINAL_CREATOR).toBuffer().toString("hex") + "64");
  assert.deepStrictEqual(ixs[1].keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]), [[ms.toBase58(), false, false], [auth.toBase58(), true, false], [m217.pda, false, true], [K.MPL.toBase58(), false, false]]);
  assert.strictEqual(roy.royaltyIxs(prog, ms, auth, { ...b283, pda: K.mdPda(b283.mint).toBase58() }, K.royaltyPlan(b283, MS)).length, 2);
  ok("update_royalty.cjs: [RemoveCreatorVerification(Gowv5)] + update_royalty(300,[GZuB:100]) + SignMetadata(GZuB), IDL discriminator");

  // ── map sha256 record (audit L3) ──
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rise-map-"));
  const mp = path.join(tmp, "uri_map.json");
  fs.writeFileSync(mp, JSON.stringify({ ...good, collection: "https://ipfs.x1forge.xyz/ipfs/QmCollection" }));
  const sh = K.sha256File(mp);
  assert.ok(K.checkVerifyRecord(mp, ["members"], sh).some((x) => /no passing/.test(x)), "no record yet");
  K.writeVerifyRecord(mp, "members", { checked: 500 });
  assert.deepStrictEqual(K.checkVerifyRecord(mp, ["members"], sh), []);
  assert.ok(K.checkVerifyRecord(mp, ["members", "collection"], sh).some((x) => /collection/.test(x)), "collection scope missing");
  assert.ok(K.checkVerifyRecord(mp, ["members"], "0".repeat(64)).some((x) => /--map-sha256 says/.test(x)), "wrong hand-recorded sha");
  assert.ok(K.checkVerifyRecord(mp, ["members"], "abc").length > 0, "malformed sha");
  fs.writeFileSync(mp, JSON.stringify({ ...good, 7: "https://ipfs.x1forge.xyz/ipfs/QmTampered" }));
  const sh2 = K.sha256File(mp);
  assert.ok(K.checkVerifyRecord(mp, ["members"], sh2).some((x) => /verified against map sha256/.test(x)), "map edited after verify");
  ok("map record: lock needs --map-sha256 == file == the sha256 a full --verify recorded, per scope");

  // ── incinerate_collection.cjs ──
  assert.strictEqual(inc.ata(inc.INCINERATOR).toBase58(), inc.EXPECTED_DEST);
  assert.strictEqual(PublicKey.isOnCurve(inc.INCINERATOR.toBuffer()), false);
  const holderPk = new PublicKey("BAMEPccJucUMiVnsPJ2V9VzH5m3Q1TD9QDZJhrof4Nxy"), src = inc.ata(holderPk);
  assert.strictEqual(src.toBase58(), "5aPXdprGkQ5pqbLoeh7tmvq2YU5itXW8inDCcGSs8fy2", "the holder ATA read from mainnet");
  const [cr, tr] = inc.incinerateIxs(holderPk, src);
  assert.deepStrictEqual([...cr.data], [1]); assert.strictEqual(cr.keys[1].pubkey.toBase58(), inc.EXPECTED_DEST); assert.strictEqual(cr.keys[2].pubkey.toBase58(), inc.INCINERATOR.toBase58());
  assert.strictEqual(tr.data.toString("hex"), "0c" + "0100000000000000" + "00", "TransferChecked 1, decimals 0");
  assert.deepStrictEqual(tr.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]), [[src.toBase58(), false, true], [K.COLLECTION_MINT, false, false], [inc.EXPECTED_DEST, false, true], [holderPk.toBase58(), true, false]]);
  const ed = inc.editionPda().toBase58();
  assert.strictEqual(ed, "FjsB7uDCVswotg71cw1hUuuhncyS3gsaY6sDDsTgwrkm");
  const st = (o = {}) => ({ mint: { supply: 1n, decimals: 0, mintAuthority: ed, freezeAuthority: ed }, holders: [{ address: src.toBase58(), info: { owner: holderPk.toBase58(), amount: 1n, state: 1, delegate: null } }],
    collection: { ...collM({}), isMutable: false }, lockedMembers: 500, holder: holderPk.toBase58(), ...o });
  assert.deepStrictEqual(inc.gate(st()), []);
  assert.ok(inc.gate(st({ collection: collM({}) })).some((x) => /not LOCKED/.test(x)));
  assert.ok(inc.gate(st({ lockedMembers: 499 })).some((x) => /499\/500/.test(x)));
  assert.ok(inc.gate(st({ holder: Keypair.generate().publicKey.toBase58() })).some((x) => /holder keypair/.test(x)));
  assert.ok(inc.gate(st({ holders: [{ address: src.toBase58(), info: { owner: holderPk.toBase58(), amount: 1n, state: 2, delegate: null } }] })).some((x) => /frozen/.test(x)));
  assert.ok(inc.gate(st({ holders: [{ address: inc.EXPECTED_DEST, info: { owner: inc.INCINERATOR.toBase58(), amount: 1n, state: 1, delegate: null } }] })).some((x) => /already/.test(x)));
  assert.ok(inc.gate(st({ mint: { supply: 1n, decimals: 0, mintAuthority: holderPk.toBase58(), freezeAuthority: ed } })).some((x) => /mint authority/.test(x)));
  assert.deepStrictEqual(inc.checkIncinerated({ mint: K.COLLECTION_MINT, owner: inc.INCINERATOR.toBase58(), amount: 1n, delegate: null, closeAuthority: null, state: 1 }, { amount: 0n }), []);
  assert.ok(inc.checkIncinerated(null, null).length === 1);
  ok("incinerate_collection.cjs: destination HQSNbZZ… = ATA(off-curve incinerator), CreateIdempotent + TransferChecked(1), gates, post-check");

  // ── CIDv0 (cross-checked with `ipfs add -n -q --cid-version 0`) ──
  // external_url = https://x1forge.xyz/collection/rise (rise-phoenix-nft branch feat/external-url-x1forge)
  const known = { "0-v3.json": "QmNUk3bpiFuFoEHSTd3hLxQXWkKKuwWqFissy4bHGsajZv", "7-v3.json": "QmfU3BQiGTEy3fw31rKNeCsWG3eQnoYbQvagRSC44cfMZ5", "499-v3.json": "QmWhKUev1quHyoYAVfnPMVrXB9ur2k5KyBi6NDjZE5npLo" };
  if (fs.existsSync(path.join(metaDir, "0-v3.json"))) for (const [f, cid] of Object.entries(known)) assert.strictEqual(pin.cidV0(fs.readFileSync(path.join(metaDir, f))), cid, f);
  assert.strictEqual(pin.cidV0(fs.readFileSync(path.join(repo, "collection/collection.jpg"))), "QmVU1bDERvZMXyLnxp88wM48HSFFrjenkE3cswzW34CrW8");
  const cj = JSON.parse(fs.readFileSync(path.join(repo, "collection/collection.json")));
  assert.strictEqual(cj.image, "https://ipfs.x1forge.xyz/ipfs/QmVU1bDERvZMXyLnxp88wM48HSFFrjenkE3cswzW34CrW8");
  assert.strictEqual(cj.external_url, K.EXTERNAL_URL);
  assert.strictEqual(pin.cidV0(fs.readFileSync(path.join(repo, "collection/collection.json"))), "QmV6Ffa7768oabHppN7L87zwujT1Pa1j3JxhzNkLFSFrVr");
  if (fs.existsSync(path.join(metaDir, "0-v3.json"))) {
    const old = fs.readFileSync(path.join(metaDir, "0-v3.json"), "utf8").replace(K.EXTERNAL_URL, "https://rise-phoenix-nft.vercel.app");
    assert.ok(pin.checkMemberFile(0, Buffer.from(old)).some((x) => /external_url/.test(x)), "old external_url refused by pin");
  }
  assert.throws(() => pin.cidV0(Buffer.alloc(0)), /empty/);
  assert.throws(() => pin.cidV0(Buffer.alloc(262145)), /chunk/);
  ok("CIDv0 equals the ipfs CLI for 3 JSONs, collection JSON and image; external_url = x1forge.xyz/collection/rise enforced");

  // ── refusal paths (exit before any network call) ──
  const run = (script, args) => spawnSync(process.execPath, [path.join(repo, script), ...args], { encoding: "utf8" });
  const refuse = (script, args, re) => { const r = run(script, args); assert.strictEqual(r.status, 1, `${script} ${args.join(" ")}: ${r.stdout}${r.stderr}`); assert.match(r.stderr, re); };
  refuse("sweep_uri.cjs", ["--map", "x.json", "--send"], /confirm-mainnet/);
  refuse("sweep_uri.cjs", [], /--map/);
  refuse("sweep_uri.cjs", ["--map", "x.json", "--limit", "abc"], /positive integer/);
  refuse("sweep_uri.cjs", ["--map", "x.json", "--limit"], /needs a value/);
  refuse("sweep_uri.cjs", ["--map", "x.json", "--token", ""], /0\.\.499/);
  refuse("sweep_uri.cjs", ["--map", "x.json", "--collection", "--token", "1"], /exclusive/);
  refuse("sweep_uri.cjs", ["--map", "x.json", "--verify", "--send", "--confirm-mainnet"], /read-only/);
  refuse("lock_metadata.cjs", ["--map", "x.json"], /exactly one/);
  refuse("lock_metadata.cjs", ["--map", "x.json", "--all", "--token", "1"], /exactly one/);
  refuse("lock_metadata.cjs", ["--map", "x.json", "--all", "--send"], /confirm-mainnet/);
  refuse("lock_metadata.cjs", ["--all"], /--map/);
  refuse("lock_metadata.cjs", ["--status", "--send", "--confirm-mainnet"], /read-only/);
  refuse("pin_metadata.cjs", ["--token", "500"], /0\.\.499/);
  refuse("pin_metadata.cjs", ["--executee"], /unknown/);
  // L1: only external_url may be exempted from the Vercel compare
  refuse("sweep_uri.cjs", ["--map", "x.json", "--verify", "--allow-vercel-diff", "image"], /only external_url/);
  refuse("sweep_uri.cjs", ["--map", "x.json", "--verify", "--allow-vercel-diff", "external_url,properties.files.0.uri"], /only external_url/);
  refuse("sweep_uri.cjs", ["--map", "x.json", "--verify", "--allow-vercel-diff", "attributes"], /only external_url/);
  refuse("sweep_uri.cjs", ["--map", "x.json", "--allow-vercel-diff", "external_url"], /only applies to --verify/);
  // L3: lock needs the recorded map sha256; the old override flags are gone
  refuse("lock_metadata.cjs", ["--map", "x.json", "--token", "7"], /--map-sha256/);
  refuse("lock_metadata.cjs", ["--map", "x.json", "--token", "7", "--map-sha256", "0".repeat(64), "--expect-bps", "100"], /unknown argument/);
  refuse("lock_metadata.cjs", ["--map", mp, "--all", "--map-sha256", sh2], /no passing sweep_uri.cjs --verify recorded for collection|verified against map sha256/);
  refuse("lock_metadata.cjs", ["--map", mp, "--token", "7", "--map-sha256", sh], /--map-sha256 says|verified against/);
  // M4: update_royalty.cjs strict
  refuse("update_royalty.cjs", ["--send"], /confirm-mainnet/);
  refuse("update_royalty.cjs", ["--limit", "abc"], /positive integer/);
  refuse("update_royalty.cjs", ["--limit"], /needs a value/);
  refuse("update_royalty.cjs", ["--mint"], /unknown argument/);
  refuse("update_royalty.cjs", ["--token", ""], /0\.\.499/);
  refuse("update_royalty.cjs", ["--cluster", "testnet"], /unknown argument/);
  refuse("update_royalty.cjs", ["--collection", "--token", "1"], /exclusive/);
  refuse("update_royalty.cjs", ["--creator", "Gowv5PDb7K4a5PwjubWegvBT4CDfjjJcG4QAZWa9yUob"], /unknown argument/);
  refuse("incinerate_collection.cjs", ["--send"], /confirm-mainnet/);
  refuse("incinerate_collection.cjs", ["--verify", "--send", "--confirm-mainnet"], /read-only/);
  refuse("incinerate_collection.cjs", ["--dest", "x"], /unknown argument/);
  refuse("readonly_checks.cjs", ["update-sim"], /exactly one/);
  refuse("readonly_checks.cjs", ["send"], /editions or update-sim/);
  ok("refusal paths: 35 bad invocations exit 1 before any network call (incl. L1, L3, M4)");
  for (const f of ["sweep_uri.cjs", "lock_metadata.cjs", "pin_metadata.cjs", "rise_meta_common.cjs", "update_royalty.cjs", "incinerate_collection.cjs", "readonly_checks.cjs"]) assert.strictEqual(spawnSync(process.execPath, ["--check", path.join(repo, f)]).status, 0);
  ok("node --check on all seven scripts");
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\nALL ${n} OFFLINE CHECK GROUPS PASSED`);
})().catch((e) => { console.error("FAILED:", e); process.exit(1); });
