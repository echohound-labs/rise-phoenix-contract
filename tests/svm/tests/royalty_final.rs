//! Owner decision 2026-11-24: final royalty for ALL 500 members and the
//! collection NFT = 300 bps, single creator GZuBHE3f… (share 100, VERIFIED).
//!
//! Metaplex rules that decide what each group needs (UpdateMetadataAccountV2 ->
//! assert_data_valid in the fixture build):
//!   * a VERIFIED creator that is not the update authority cannot be dropped or
//!     un-flagged by an update (CannotUnverifyAnotherCreator, 55). So the 217
//!     members with [Gowv5:100 verified] first need Gowv5 to sign
//!     RemoveCreatorVerification (28) on itself.
//!   * a verified creator that IS the signing update authority may be dropped.
//!     mint_state is both, and signs the CPI through its seeds, so the 283
//!     members and the collection NFT with [mint_state:100 verified] need no
//!     un-verify step.
//!   * a new creator always starts unverified; GZuB then signs SignMetadata (7).
//!
//! One transaction per token, exactly as update_royalty.cjs builds it:
//!   [RemoveCreatorVerification(Gowv5)]  only for the 217 group
//!   update_royalty(300, [GZuB:100])      signed by mint_state.authority
//!   SignMetadata(GZuB)
//!
//! Two kinds of state are used:
//!   * mainnet: the real metadata bytes of #0 (283 group), #1 (217 group) and
//!     the collection NFT FRN2yo3…, read 2026-11-24 (fixtures/mainnet/), run on
//!     X1 MAINNET's own Token Metadata binary (fixtures/mpl_token_metadata_x1_mainnet.so,
//!     `solana program dump metaqbx…`, sha256 bb0842f6…58e4), with the real
//!     keys and sigverify off. X1's accounts are 607 bytes; the older fixture
//!     Metaplex (679-byte layout) refuses them with DataTypeMismatch (63), so
//!     the fixture binary cannot stand in for mainnet here;
//!   * fixture: state built by the LIVE program (common::setup()) on the fixture
//!     Metaplex, then upgraded to the freeze build, with real signatures.
//! Every path ends with lock_metadata and a refused update (Metaplex 59).

mod common;
use common::*;
use solana_sdk::{message::Message, signature::Signature};

const MINT_AUTHORITY: Pubkey = pubkey!("BAMEPccJucUMiVnsPJ2V9VzH5m3Q1TD9QDZJhrof4Nxy");
const GOWV5: Pubkey = pubkey!("Gowv5PDb7K4a5PwjubWegvBT4CDfjjJcG4QAZWa9yUob");
const GZUB: Pubkey = pubkey!("GZuBHE3fQCQ6eSTLMwWKrK15CjtWfA58BmxdtWwG5mJJ");
const COLLECTION_MINT: Pubkey = pubkey!("hzdZak4qN9bZ93ztu4bTBmDwx6F3XNyieFG5SQqCsJm");
const COLLECTION_METADATA: Pubkey = pubkey!("FRN2yo3JLHV3ZXqcwsAgxRcDu2YFTQjvjT4cg35J6inR");
const MEMBER0_METADATA: Pubkey = pubkey!("Gq7RdkVtmcNWuWtZGr5onpg2AkaEwUSZToJmDmtcu4wf");
const MEMBER1_METADATA: Pubkey = pubkey!("8sUV3jVBacWNv5R1xhUpRnKqHRYA2qsw7HQNqzMByaGN");
const TARGET_BPS: u16 = 300;

const MPL_CANNOT_UNVERIFY_ANOTHER_CREATOR: u32 = 55;
const MPL_DATA_IS_IMMUTABLE: u32 = 59;

const MD_283: &[u8] = include_bytes!("../fixtures/mainnet/member0_283_mintstate.bin");
const MD_217: &[u8] = include_bytes!("../fixtures/mainnet/member1_217_gowv5.bin");
const MD_COLL: &[u8] = include_bytes!("../fixtures/mainnet/collection_FRN2yo3.bin");

// ── instructions (same bytes as update_royalty.cjs / lock_metadata.cjs) ─────

fn sign_metadata_ix(metadata: Pubkey, creator: Pubkey) -> Instruction {
    Instruction {
        program_id: MPL,
        accounts: vec![AccountMeta::new(metadata, false), AccountMeta::new_readonly(creator, true)],
        data: vec![7],
    }
}
fn remove_creator_verification_ix(metadata: Pubkey, creator: Pubkey) -> Instruction {
    Instruction {
        program_id: MPL,
        accounts: vec![AccountMeta::new(metadata, false), AccountMeta::new_readonly(creator, true)],
        data: vec![28],
    }
}
fn lock_ix(mint_state: Pubkey, authority: Pubkey, metadata: Pubkey) -> Instruction {
    Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new_readonly(mint_state, false),
            AccountMeta::new_readonly(authority, true),
            AccountMeta::new(metadata, false),
            AccountMeta::new_readonly(MPL, false),
        ],
        data: disc("global", "lock_metadata").to_vec(),
    }
}
/// The script's transaction body for one token.
fn final_royalty_ixs(ms: Pubkey, auth: Pubkey, md: Pubkey, unverify: Option<Pubkey>, target: Pubkey) -> Vec<Instruction> {
    let mut v = vec![];
    if let Some(old) = unverify {
        v.push(remove_creator_verification_ix(md, old));
    }
    v.push(update_royalty_ix(ms, auth, md, TARGET_BPS, &[(target, 100)]));
    v.push(sign_metadata_ix(md, target));
    v
}

/// `after` must equal `before` in every parsed field (tail bytes included)
/// except the royalty and the creator list, which must be exactly [target:100✓].
fn assert_only_royalty_changed(before: &Md, after: &Md, target: Pubkey) {
    let mut want = before.clone();
    want.seller_fee_basis_points = TARGET_BPS;
    want.creators = Some(vec![Creator { address: target, verified: true, share: 100 }]);
    assert_eq!(after, &want, "a field other than royalty/creators changed");
}

fn dump(name: &str, data: &[u8]) {
    let dir = format!("{}/target/metadata-dumps", env!("CARGO_MANIFEST_DIR"));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(format!("{dir}/{name}"), data).unwrap();
}

// ── mainnet-bytes harness (sigverify off, real keys) ────────────────────────

struct Main {
    svm: LiteSVM,
    ms: Pubkey,
}
impl Main {
    fn new(so: &str) -> Self {
        let mut svm = LiteSVM::new().with_sigverify(false);
        let root = env!("CARGO_MANIFEST_DIR");
        svm.add_program_from_file(MPL, format!("{root}/fixtures/mpl_token_metadata_x1_mainnet.so")).unwrap();
        svm.add_program_from_file(PROGRAM_ID, so).unwrap();
        for k in [MINT_AUTHORITY, GOWV5, GZUB] {
            svm.airdrop(&k, 10_000_000_000).unwrap();
        }
        let (ms, bump) = mint_state_pda();
        let mut d = disc("account", "MintState").to_vec();
        d.extend_from_slice(&500u32.to_le_bytes());
        d.extend_from_slice(MINT_AUTHORITY.as_ref());
        d.push(bump);
        let mut bitmap = [0u64; 8];
        for i in 0..500 {
            bitmap[i / 64] |= 1 << (i % 64);
        }
        for w in bitmap {
            d.extend_from_slice(&w.to_le_bytes());
        }
        let lamports = svm.minimum_balance_for_rent_exemption(d.len());
        svm.set_account(ms, Account { lamports, data: d, owner: PROGRAM_ID, executable: false, rent_epoch: 0 }).unwrap();
        for (k, bytes) in [(MEMBER0_METADATA, MD_283), (MEMBER1_METADATA, MD_217), (COLLECTION_METADATA, MD_COLL)] {
            svm.set_account(k, Account { lamports: 15_115_600, data: bytes.to_vec(), owner: MPL, executable: false, rent_epoch: 0 })
                .unwrap();
        }
        Main { svm, ms }
    }
    fn send(&mut self, ixs: &[Instruction]) -> Result<u64, TransactionError> {
        self.svm.expire_blockhash();
        let mut all = vec![ComputeBudgetInstruction::set_compute_unit_limit(200_000)];
        all.extend_from_slice(ixs);
        let msg = Message::new_with_blockhash(&all, Some(&MINT_AUTHORITY), &self.svm.latest_blockhash());
        let n = msg.header.num_required_signatures as usize;
        let tx = Transaction { signatures: (0..n).map(|_| Signature::new_unique()).collect(), message: msg };
        self.svm.send_transaction(tx).map(|m| m.compute_units_consumed).map_err(|f| {
            eprintln!("tx failed: {:?}\n{}", f.err, f.meta.logs.join("\n"));
            f.err
        })
    }
    fn raw(&self, k: &Pubkey) -> Account {
        self.svm.get_account(k).unwrap()
    }
    fn md(&self, k: &Pubkey) -> Md {
        parse(&self.raw(k).data)
    }
    fn royalty(&mut self, md: Pubkey, unverify: Option<Pubkey>) -> Result<u64, TransactionError> {
        let ixs = final_royalty_ixs(self.ms, MINT_AUTHORITY, md, unverify, GZUB);
        self.send(&ixs)
    }
    fn lock(&mut self, md: Pubkey) -> Result<u64, TransactionError> {
        self.send(&[lock_ix(self.ms, MINT_AUTHORITY, md)])
    }
    /// After a lock: update_royalty, update_token_uri and the royalty tx itself all fail with 59.
    fn assert_updates_refused(&mut self, md: Pubkey) {
        let locked = self.raw(&md);
        let ms = self.ms;
        for (what, ixs) in [
            ("update_royalty", vec![update_royalty_ix(ms, MINT_AUTHORITY, md, 500, &[(ms, 100)])]),
            ("update_royalty same target", vec![update_royalty_ix(ms, MINT_AUTHORITY, md, TARGET_BPS, &[(GZUB, 100)])]),
            ("update_token_uri", vec![update_token_uri_ix(ms, MINT_AUTHORITY, md, NEW_URI)]),
            ("update_token_uri back to Vercel", vec![update_token_uri_ix(ms, MINT_AUTHORITY, md, OLD_URI)]),
        ] {
            let err = self.send(&ixs).unwrap_err();
            assert_eq!(custom(&err), Some(MPL_DATA_IS_IMMUTABLE), "{what} after lock: {err:?}");
            assert_eq!(self.raw(&md), locked, "{what}: locked account changed");
        }
    }
}

fn assert_mainnet_start() {
    let m = parse(MD_283);
    assert_eq!((m.name.as_str(), m.seller_fee_basis_points), ("RISE Phoenix #0", 500));
    assert_eq!(m.creators, Some(vec![Creator { address: mint_state_pda().0, verified: true, share: 100 }]));
    assert_eq!(m.collection, Some((true, COLLECTION_MINT)));
    let m = parse(MD_217);
    assert_eq!((m.name.as_str(), m.seller_fee_basis_points), ("RISE Phoenix #1", 100));
    assert_eq!(m.creators, Some(vec![Creator { address: GOWV5, verified: true, share: 100 }]));
    assert_eq!(m.collection, Some((true, COLLECTION_MINT)));
    let m = parse(MD_COLL);
    assert_eq!((m.name.as_str(), m.seller_fee_basis_points, m.mint), ("RISE Phoenix", 500, COLLECTION_MINT));
    assert_eq!(m.creators, Some(vec![Creator { address: mint_state_pda().0, verified: true, share: 100 }]));
    assert!(m.collection_details.is_some(), "sized collection");
    for b in [MD_283, MD_217, MD_COLL] {
        let m = parse(b);
        assert!(m.is_mutable && m.update_authority == mint_state_pda().0);
    }
}

// ── 217 group: [Gowv5:100 verified] @ 100 bps ───────────────────────────────

#[test]
fn mainnet_217_group_needs_gowv5_unverify_then_reaches_target_then_locks() {
    assert_mainnet_start();
    for so in [live_so(), freeze_so()] {
        let mut s = Main::new(&so);
        let before_acc = s.raw(&MEMBER1_METADATA);
        let before = parse(&before_acc.data);

        // Without Gowv5's un-verify, every variant is refused by Metaplex (55) and nothing changes.
        let ms = s.ms;
        let err = s.send(&[update_royalty_ix(ms, MINT_AUTHORITY, MEMBER1_METADATA, TARGET_BPS, &[(GZUB, 100)])]).unwrap_err();
        assert_eq!(custom(&err), Some(MPL_CANNOT_UNVERIFY_ANOTHER_CREATOR), "{err:?}");
        let err = s.royalty(MEMBER1_METADATA, None).unwrap_err();
        assert_eq!(custom(&err), Some(MPL_CANNOT_UNVERIFY_ANOTHER_CREATOR), "{err:?}");
        // Keeping Gowv5 at share 0 is not a way round it either: it would stay a listed creator.
        // Un-verify signed by someone other than Gowv5 (GZuB is not a creator here) fails too.
        assert!(s.royalty(MEMBER1_METADATA, Some(GZUB)).is_err());
        assert_eq!(s.raw(&MEMBER1_METADATA), before_acc, "refused attempts left the account byte-identical");

        // The script's transaction: un-verify Gowv5, update, GZuB signs.
        let cu = s.royalty(MEMBER1_METADATA, Some(GOWV5)).expect("217 path");
        let after = s.md(&MEMBER1_METADATA);
        assert_only_royalty_changed(&before, &after, GZUB);
        assert_eq!(after.collection, Some((true, COLLECTION_MINT)), "collection stays verified");
        assert_eq!(s.raw(&MEMBER1_METADATA).data.len(), before_acc.data.len());
        println!("{so}: 217 path ok, {cu} CU (incl. compute-budget ix)");

        if so == freeze_so() {
            dump("royalty_217_after.bin", &s.raw(&MEMBER1_METADATA).data);
            let pre_lock = s.raw(&MEMBER1_METADATA);
            s.lock(MEMBER1_METADATA).expect("lock");
            let locked = s.md(&MEMBER1_METADATA);
            let mut want = parse(&pre_lock.data);
            want.is_mutable = false;
            assert_eq!(locked, want, "lock changed only is_mutable");
            s.assert_updates_refused(MEMBER1_METADATA);
            dump("royalty_217_locked.bin", &s.raw(&MEMBER1_METADATA).data);
        }
    }
}

// ── 283 group: [mint_state:100 verified] @ 500 bps ──────────────────────────

#[test]
fn mainnet_283_group_drops_verified_mint_state_without_unverify_then_locks() {
    for so in [live_so(), freeze_so()] {
        let mut s = Main::new(&so);
        let before = s.md(&MEMBER0_METADATA);
        // Gowv5 is not a creator here; an un-verify step would only make the tx fail.
        assert!(s.royalty(MEMBER0_METADATA, Some(GOWV5)).is_err());
        let cu = s.royalty(MEMBER0_METADATA, None).expect("283 path");
        let after = s.md(&MEMBER0_METADATA);
        assert_only_royalty_changed(&before, &after, GZUB);
        assert!(!after.creators.as_ref().unwrap().iter().any(|c| c.address == s.ms), "mint_state dropped");
        println!("{so}: 283 path ok, {cu} CU");

        if so == freeze_so() {
            dump("royalty_283_after.bin", &s.raw(&MEMBER0_METADATA).data);
            s.lock(MEMBER0_METADATA).expect("lock");
            assert!(!s.md(&MEMBER0_METADATA).is_mutable);
            s.assert_updates_refused(MEMBER0_METADATA);
        }
    }
}

// ── collection NFT FRN2yo3…: [mint_state:100 verified] @ 500 bps ────────────

#[test]
fn mainnet_collection_nft_reaches_target_keeps_size_then_locks() {
    let mut s = Main::new(&freeze_so());
    let before = s.md(&COLLECTION_METADATA);
    let cu = s.royalty(COLLECTION_METADATA, None).expect("collection path");
    let after = s.md(&COLLECTION_METADATA);
    assert_only_royalty_changed(&before, &after, GZUB);
    assert_eq!(after.collection_details, before.collection_details, "size counter kept");
    assert_eq!(after.collection, None);
    println!("collection path ok, {cu} CU");
    dump("royalty_collection_after.bin", &s.raw(&COLLECTION_METADATA).data);

    s.lock(COLLECTION_METADATA).expect("lock collection");
    s.assert_updates_refused(COLLECTION_METADATA);

    // Members are separate accounts: the collection lock does not stop a member's royalty fix.
    s.royalty(MEMBER0_METADATA, None).expect("member after collection lock");
    s.royalty(MEMBER1_METADATA, Some(GOWV5)).expect("member after collection lock");
}

#[test]
fn mainnet_all_three_then_lock_then_residual_powers() {
    // The whole order on one SVM: royalty on both member groups + collection, then lock all three.
    let mut s = Main::new(&freeze_so());
    s.royalty(MEMBER1_METADATA, Some(GOWV5)).unwrap();
    s.royalty(MEMBER0_METADATA, None).unwrap();
    s.royalty(COLLECTION_METADATA, None).unwrap();
    // Re-running the royalty update with the same target before lock is harmless (no change).
    let snap = s.raw(&MEMBER0_METADATA);
    let ms = s.ms;
    s.send(&[update_royalty_ix(ms, MINT_AUTHORITY, MEMBER0_METADATA, TARGET_BPS, &[(GZUB, 100)])]).unwrap();
    assert_eq!(s.raw(&MEMBER0_METADATA), snap, "idempotent: GZuB keeps its verified flag");
    for k in [MEMBER0_METADATA, MEMBER1_METADATA, COLLECTION_METADATA] {
        s.lock(k).unwrap();
        s.assert_updates_refused(k);
    }
    // Audit I2, still true with GZuB: the creator can toggle its OWN verified flag after lock.
    // Address, share and bps cannot change. Recorded here so the report states it exactly.
    let locked = s.md(&MEMBER0_METADATA);
    s.send(&[remove_creator_verification_ix(MEMBER0_METADATA, GZUB)]).expect("GZuB un-verifies itself");
    let unv = s.md(&MEMBER0_METADATA);
    assert_eq!(unv.creators, Some(vec![Creator { address: GZUB, verified: false, share: 100 }]));
    assert_eq!(unv.seller_fee_basis_points, TARGET_BPS);
    s.send(&[sign_metadata_ix(MEMBER0_METADATA, GZUB)]).expect("and re-verifies");
    assert_eq!(s.md(&MEMBER0_METADATA), locked);
    // Gowv5 has no power over a fixed member any more.
    assert!(s.send(&[remove_creator_verification_ix(MEMBER1_METADATA, GOWV5)]).is_err());
    assert!(s.send(&[sign_metadata_ix(MEMBER1_METADATA, GOWV5)]).is_err());
}

// ── fixture state built by the LIVE program, then upgraded (real signatures) ─

#[test]
fn fixture_217_shape_member_built_by_live_program() {
    // setup()'s member is exactly the 217 shape: [creator:100 verified] @ 100 bps.
    let mut env = setup();
    let auth = env.authority.insecure_clone();
    let old = env.creator.insecure_clone(); // stands in for Gowv5
    let target = Keypair::new(); // stands in for GZuB
    env.svm.airdrop(&target.pubkey(), 1_000_000_000).unwrap();
    let md = metadata_pda(&env.member_mint);
    let before = env.md(&env.member_mint);
    assert_eq!(before.creators, Some(vec![Creator { address: old.pubkey(), verified: true, share: 100 }]));

    let ixs = final_royalty_ixs(env.mint_state, auth.pubkey(), md, None, target.pubkey());
    let err = env.send(&ixs, &[&auth, &target]).unwrap_err();
    assert_eq!(custom(&err), Some(MPL_CANNOT_UNVERIFY_ANOTHER_CREATOR), "{err:?}");

    let ixs = final_royalty_ixs(env.mint_state, auth.pubkey(), md, Some(old.pubkey()), target.pubkey());
    env.send(&ixs, &[&auth, &old, &target]).expect("217 path, three real signatures");
    assert_only_royalty_changed(&before, &env.md(&env.member_mint), target.pubkey());

    let m = env.member_mint;
    env.send(&[lock_ix(env.mint_state, auth.pubkey(), metadata_pda(&m))], &[&auth]).expect("lock");
    let err = env.send(&[update_royalty_ix(env.mint_state, auth.pubkey(), md, 100, &[(old.pubkey(), 100)])], &[&auth]).unwrap_err();
    assert_eq!(custom(&err), Some(MPL_DATA_IS_IMMUTABLE));
    let err = call(&mut env, &auth, NEW_URI).unwrap_err();
    assert_eq!(custom(&err), Some(MPL_DATA_IS_IMMUTABLE));
}

#[test]
fn fixture_283_shape_member() {
    // Only fulfill_mint (oracle path) ever produced [mint_state:100 verified]; it
    // cannot run offline, so setup()'s member is given that creator entry in place
    // (same length: one 34-byte entry) and 500 bps, matching mainnet #0.
    let mut env = setup();
    let auth = env.authority.insecure_clone();
    let target = Keypair::new();
    env.svm.airdrop(&target.pubkey(), 1_000_000_000).unwrap();
    let md = metadata_pda(&env.member_mint);
    let mut acc = env.raw_md(&env.member_mint);
    let p = parse(&acc.data);
    let fee_off = p.psh_offset - 4 - 34 - 1 - 2; // fee | Some | len | 1 entry | psh
    acc.data[fee_off..fee_off + 2].copy_from_slice(&500u16.to_le_bytes());
    let c_off = fee_off + 2 + 1 + 4;
    acc.data[c_off..c_off + 32].copy_from_slice(env.mint_state.as_ref());
    assert_eq!(acc.data[c_off + 32], 1, "verified");
    env.svm.set_account(md, acc).unwrap();
    let before = env.md(&env.member_mint);
    assert_eq!(before.seller_fee_basis_points, 500);
    assert_eq!(before.creators, Some(vec![Creator { address: env.mint_state, verified: true, share: 100 }]));

    let ixs = final_royalty_ixs(env.mint_state, auth.pubkey(), md, None, target.pubkey());
    env.send(&ixs, &[&auth, &target]).expect("283 path");
    assert_only_royalty_changed(&before, &env.md(&env.member_mint), target.pubkey());

    let m = env.member_mint;
    env.send(&[lock_ix(env.mint_state, auth.pubkey(), metadata_pda(&m))], &[&auth]).expect("lock");
    let err = env.send(&[update_royalty_ix(env.mint_state, auth.pubkey(), md, 500, &[(env.mint_state, 100)])], &[&auth]).unwrap_err();
    assert_eq!(custom(&err), Some(MPL_DATA_IS_IMMUTABLE));
}

#[test]
fn fixture_collection_nft_built_by_live_create_collection() {
    // The live program's create_collection made it: [mint_state:100 verified] @ 500 bps.
    let mut env = setup();
    let auth = env.authority.insecure_clone();
    let target = Keypair::new();
    env.svm.airdrop(&target.pubkey(), 1_000_000_000).unwrap();
    let coll = env.collection_mint;
    let md = metadata_pda(&coll);
    let before = env.md(&coll);
    assert_eq!(before.seller_fee_basis_points, 500);
    assert_eq!(before.creators, Some(vec![Creator { address: env.mint_state, verified: true, share: 100 }]));
    let member_before = env.raw_md(&env.member_mint);

    let ixs = final_royalty_ixs(env.mint_state, auth.pubkey(), md, None, target.pubkey());
    env.send(&ixs, &[&auth, &target]).expect("collection path");
    let after = env.md(&coll);
    assert_only_royalty_changed(&before, &after, target.pubkey());
    assert_eq!(after.collection_details, before.collection_details);
    assert_eq!(env.raw_md(&env.member_mint), member_before, "member untouched");

    env.send(&[lock_ix(env.mint_state, auth.pubkey(), md)], &[&auth]).expect("lock");
    let err = env.send(&[update_royalty_ix(env.mint_state, auth.pubkey(), md, 500, &[(env.mint_state, 100)])], &[&auth]).unwrap_err();
    assert_eq!(custom(&err), Some(MPL_DATA_IS_IMMUTABLE));
    assert_eq!(env.md(&env.member_mint).collection, Some((true, coll)), "member still verified");
}
