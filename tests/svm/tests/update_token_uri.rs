//! Offline tests for `update_token_uri` (and a regression check of `update_royalty`).
//!
//! Everything runs in-process on LiteSVM: no validator, no RPC, no keypair files.
//! The program under test is `target/deploy/rise_phoenix_contract.so` from `anchor build`.
//!
//! The member NFT is built to match the live mainnet state as closely as the
//! program allows: update authority = mint_state PDA, one creator at 100% and
//! VERIFIED (as after update_royalty + SignMetadata), a VERIFIED sized collection
//! (via the program's own verify_collection), a master edition (via the program's
//! own create_member_master_edition), is_mutable = true.
//!
//! Freeze build: that state is now built with the LIVE binary (883f4b6) and the
//! program is then upgraded in place to the freeze build; see common/mod.rs.

mod common;
use common::*;

// ── Tests ──────────────────────────────────────────────────────────────────

#[test]
fn happy_path_changes_only_uri() {
    let mut env = setup();
    let before = env.md(&env.member_mint);
    let coll_before = env.raw_md(&env.collection_mint);
    let auth = env.authority.insecure_clone();
    let dir = format!("{}/target/metadata-dumps", env!("CARGO_MANIFEST_DIR"));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(format!("{dir}/before.bin"), &env.raw_md(&env.member_mint).data).unwrap();
    std::fs::write(format!("{dir}/collection_mint.txt"), env.collection_mint.to_string()).unwrap();

    let cu = call(&mut env, &auth, NEW_URI).expect("update_token_uri");
    println!("update_token_uri compute units (incl. compute-budget ix): {cu}");

    let after = env.md(&env.member_mint);
    assert_only_uri_changed(&before, &after, NEW_URI);
    // Real Metaplex account bytes, used to check sweep_uri.cjs's parser offline.
    let dir = format!("{}/target/metadata-dumps", env!("CARGO_MANIFEST_DIR"));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(format!("{dir}/after.bin"), &env.raw_md(&env.member_mint).data).unwrap();
    std::fs::write(format!("{dir}/collection.bin"), &coll_before.data).unwrap();
    assert_eq!(after.collection, Some((true, env.collection_mint)), "collection must stay verified");
    assert!(after.creators.as_ref().unwrap()[0].verified, "creator must stay verified");
    assert!(!after.primary_sale_happened);
    assert!(after.is_mutable);
    // The collection NFT (and its size counter) is untouched.
    assert_eq!(env.raw_md(&env.collection_mint), coll_before);
}

#[test]
fn primary_sale_happened_true_is_preserved() {
    let mut env = setup();
    // Flip primary_sale_happened on directly, so we can see None leaves it alone.
    let mut acc = env.raw_md(&env.member_mint);
    let off = parse(&acc.data).psh_offset;
    acc.data[off] = 1;
    env.svm.set_account(metadata_pda(&env.member_mint), acc).unwrap();
    let before = env.md(&env.member_mint);
    assert!(before.primary_sale_happened);

    let auth = env.authority.insecure_clone();
    call(&mut env, &auth, NEW_URI).expect("update_token_uri");
    let after = env.md(&env.member_mint);
    assert_only_uri_changed(&before, &after, NEW_URI);
    assert!(after.primary_sale_happened);
}

#[test]
fn rejects_wrong_authority() {
    let mut env = setup();
    let before = env.raw_md(&env.member_mint);
    let impostor = Keypair::new();
    env.svm.airdrop(&impostor.pubkey(), 1_000_000_000).unwrap();
    let err = call(&mut env, &impostor, NEW_URI).unwrap_err();
    assert_eq!(custom(&err), Some(CONSTRAINT_HAS_ONE), "{err:?}");
    assert_eq!(env.raw_md(&env.member_mint), before);
}

#[test]
fn rejects_unsigned_authority() {
    // Real authority listed but not signing; the impostor pays and signs.
    let mut env = setup();
    let before = env.raw_md(&env.member_mint);
    let payer = Keypair::new();
    env.svm.airdrop(&payer.pubkey(), 1_000_000_000).unwrap();
    let mut ix = update_token_uri_ix(env.mint_state, env.authority.pubkey(), metadata_pda(&env.member_mint), NEW_URI);
    ix.accounts[1].is_signer = false;
    let err = env.send(&[ix], &[&payer]).unwrap_err();
    assert_eq!(custom(&err), Some(3010), "AccountNotSigner expected, got {err:?}");
    assert_eq!(env.raw_md(&env.member_mint), before);
}

#[test]
fn rejects_empty_uri() {
    let mut env = setup();
    let before = env.raw_md(&env.member_mint);
    let auth = env.authority.insecure_clone();
    let err = call(&mut env, &auth, "").unwrap_err();
    assert_eq!(custom(&err), Some(ERR_EMPTY_URI), "{err:?}");
    assert_eq!(env.raw_md(&env.member_mint), before);
}

#[test]
fn uri_length_limit_is_200_bytes() {
    let mut env = setup();
    let auth = env.authority.insecure_clone();
    let before = env.raw_md(&env.member_mint);

    let too_long = format!("https://x/{}", "a".repeat(201 - 10));
    assert_eq!(too_long.len(), 201);
    let err = call(&mut env, &auth, &too_long).unwrap_err();
    assert_eq!(custom(&err), Some(ERR_URI_TOO_LONG), "{err:?}");
    assert_eq!(env.raw_md(&env.member_mint), before);

    // Length is in bytes: 100 two-byte chars + 1 = 201 bytes, rejected.
    let multibyte = format!("h{}", "é".repeat(100));
    assert_eq!(multibyte.len(), 201);
    let err = call(&mut env, &auth, &multibyte).unwrap_err();
    assert_eq!(custom(&err), Some(ERR_URI_TOO_LONG), "{err:?}");

    let max = format!("https://x/{}", "b".repeat(200 - 10));
    assert_eq!(max.len(), 200);
    let md_before = env.md(&env.member_mint);
    call(&mut env, &auth, &max).expect("200-byte uri accepted");
    assert_only_uri_changed(&md_before, &env.md(&env.member_mint), &max);
}

#[test]
fn rejects_non_metadata_account() {
    let mut env = setup();
    let auth = env.authority.insecure_clone();
    // A program-owned look-alike: copy the real metadata bytes into an account
    // NOT owned by Metaplex. Metaplex must refuse to update it.
    let mut fake = env.raw_md(&env.member_mint);
    fake.owner = PROGRAM_ID;
    let fake_key = Pubkey::new_unique();
    env.svm.set_account(fake_key, fake.clone()).unwrap();
    let ix = update_token_uri_ix(env.mint_state, auth.pubkey(), fake_key, NEW_URI);
    assert!(env.send(&[ix], &[&auth]).is_err());
    assert_eq!(env.svm.get_account(&fake_key).unwrap(), fake);
}

#[test]
fn repeat_and_revert_round_trip() {
    let mut env = setup();
    let auth = env.authority.insecure_clone();
    let original = env.md(&env.member_mint);
    call(&mut env, &auth, NEW_URI).unwrap();
    call(&mut env, &auth, NEW_URI).expect("idempotent re-send");
    call(&mut env, &auth, OLD_URI).expect("revert (the undo for a pilot)");
    assert_eq!(env.md(&env.member_mint), original, "revert restores the exact original state");
}

#[test]
fn update_royalty_still_works_and_keeps_new_uri() {
    let mut env = setup();
    let auth = env.authority.insecure_clone();
    call(&mut env, &auth, NEW_URI).unwrap();
    let before = env.md(&env.member_mint);
    let ix = update_royalty_ix(env.mint_state, auth.pubkey(), metadata_pda(&env.member_mint), 250, &[(env.creator.pubkey(), 100)]);
    env.send(&[ix], &[&auth]).expect("update_royalty");
    let after = env.md(&env.member_mint);
    assert_eq!(after.uri, NEW_URI);
    assert_eq!(after.seller_fee_basis_points, 250);
    assert_eq!(after.collection, before.collection);
    assert_eq!(after.creators, before.creators);
}
