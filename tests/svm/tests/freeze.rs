//! Offline tests for the freeze build: removed instructions, lock_metadata,
//! and what stays possible (close_pending_mint).
//!
//! setup() builds the member + collection with the LIVE binary (883f4b6) and
//! then upgrades in place to target/deploy/rise_phoenix_contract.so, so every
//! assertion here is about the freeze build acting on state the live program
//! created.

mod common;
use common::*;
use solana_sdk::{message::Message, signature::Signature};

const MINT_AUTHORITY: Pubkey = pubkey!("BAMEPccJucUMiVnsPJ2V9VzH5m3Q1TD9QDZJhrof4Nxy");
const INSTRUCTION_FALLBACK_NOT_FOUND: u32 = 101;
const ACCOUNT_NOT_SIGNER: u32 = 3010;
const ACCOUNT_NOT_INITIALIZED: u32 = 3012;
/// Metaplex Token Metadata `DataIsImmutable` (59 = 0x3b, mpl-token-metadata 4.1.2
/// generated/errors). Error numbers are Metaplex's, so this also pins the fixture.
const MPL_DATA_IS_IMMUTABLE: u32 = 59;

const REMOVED: [&str; 7] = [
    "close_mint_state",
    "initialize",
    "request_mint",
    "fulfill_mint",
    "create_collection",
    "verify_collection",
    "create_member_master_edition",
];

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

fn lock(env: &mut Env, signer: &Keypair, mint: &Pubkey) -> Result<u64, TransactionError> {
    let ix = lock_ix(env.mint_state, signer.pubkey(), metadata_pda(mint));
    env.send(&[ix], &[signer])
}
fn lock_member(env: &mut Env, signer: &Keypair) -> Result<u64, TransactionError> {
    let m = env.member_mint;
    lock(env, signer, &m)
}

/// A realistic account list for each removed instruction, as its old accounts
/// struct declared it. `who` is listed as the signer/payer.
fn removed_ix(env: &Env, name: &str, who: Pubkey) -> Instruction {
    let ms = env.mint_state;
    let new_mint = Pubkey::new_unique();
    let accounts = match name {
        "close_mint_state" => vec![AccountMeta::new(ms, false), AccountMeta::new(who, true)],
        "initialize" => vec![
            AccountMeta::new(ms, false),
            AccountMeta::new(who, true),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
        "request_mint" => vec![
            AccountMeta::new(ms, false),
            AccountMeta::new(who, true),
            AccountMeta::new(Pubkey::find_program_address(&[b"pending_mint", who.as_ref()], &PROGRAM_ID).0, false),
            AccountMeta::new(Pubkey::new_unique(), false),
            AccountMeta::new_readonly(Pubkey::new_unique(), false),
            AccountMeta::new(Pubkey::new_unique(), false),
            AccountMeta::new_readonly(pubkey!("BxUNg2yo5371BQMZPkfcxdCptFRDHkhvEXNM1QNPBRYU"), false),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
        "fulfill_mint" => vec![
            AccountMeta::new(ms, false),
            AccountMeta::new(who, true),
            AccountMeta::new(Pubkey::find_program_address(&[b"pending_mint", who.as_ref()], &PROGRAM_ID).0, false),
            AccountMeta::new_readonly(Pubkey::new_unique(), false),
            AccountMeta::new(new_mint, true),
            AccountMeta::new(ata(&who, &new_mint), false),
            AccountMeta::new(metadata_pda(&new_mint), false),
            AccountMeta::new(pubkey!("HGFisVbULNKqogtPuGTfcHG9y6i5nboZabYwifkiiodo"), false),
            AccountMeta::new_readonly(TOKEN, false),
            AccountMeta::new_readonly(ATA, false),
            AccountMeta::new_readonly(system_program::id(), false),
            AccountMeta::new_readonly(MPL, false),
            AccountMeta::new_readonly(sysvar::rent::id(), false),
            AccountMeta::new_readonly(env.collection_mint, false),
            AccountMeta::new(metadata_pda(&env.collection_mint), false),
            AccountMeta::new_readonly(edition_pda(&env.collection_mint), false),
            AccountMeta::new(edition_pda(&new_mint), false),
        ],
        "create_collection" => vec![
            AccountMeta::new_readonly(ms, false),
            AccountMeta::new(who, true),
            AccountMeta::new(new_mint, true),
            AccountMeta::new(ata(&who, &new_mint), false),
            AccountMeta::new(metadata_pda(&new_mint), false),
            AccountMeta::new(edition_pda(&new_mint), false),
            AccountMeta::new_readonly(TOKEN, false),
            AccountMeta::new_readonly(ATA, false),
            AccountMeta::new_readonly(MPL, false),
            AccountMeta::new_readonly(system_program::id(), false),
            AccountMeta::new_readonly(sysvar::rent::id(), false),
        ],
        "verify_collection" => vec![
            AccountMeta::new_readonly(ms, false),
            AccountMeta::new(who, true),
            AccountMeta::new(metadata_pda(&env.member_mint), false),
            AccountMeta::new_readonly(env.collection_mint, false),
            AccountMeta::new(metadata_pda(&env.collection_mint), false),
            AccountMeta::new_readonly(edition_pda(&env.collection_mint), false),
            AccountMeta::new_readonly(MPL, false),
        ],
        "create_member_master_edition" => vec![
            AccountMeta::new_readonly(ms, false),
            AccountMeta::new(who, true),
            AccountMeta::new(metadata_pda(&env.member_mint), false),
            AccountMeta::new(env.member_mint, false),
            AccountMeta::new(edition_pda(&env.member_mint), false),
            AccountMeta::new_readonly(MPL, false),
            AccountMeta::new_readonly(TOKEN, false),
            AccountMeta::new_readonly(system_program::id(), false),
            AccountMeta::new_readonly(sysvar::rent::id(), false),
        ],
        _ => unreachable!(),
    };
    let mut data = disc("global", name).to_vec();
    if name == "create_collection" {
        borsh_str(&mut data, "https://evil.example/collection.json");
    }
    Instruction { program_id: PROGRAM_ID, accounts, data }
}

/// Send with sigverify off, so a transaction can be "signed" by a key whose
/// secret we do not have (the real MINT_AUTHORITY). Test-only.
fn send_as(svm: &mut LiteSVM, ixs: &[Instruction], payer: &Pubkey) -> Result<(), TransactionError> {
    svm.expire_blockhash();
    let msg = Message::new_with_blockhash(ixs, Some(payer), &svm.latest_blockhash());
    let n = msg.header.num_required_signatures as usize;
    // unique dummy signatures: identical ones would be rejected as AlreadyProcessed
    let tx = Transaction { signatures: (0..n).map(|_| Signature::new_unique()).collect(), message: msg };
    svm.send_transaction(tx).map(|_| ()).map_err(|f| {
        eprintln!("tx failed: {:?}\n{}", f.err, f.meta.logs.join("\n"));
        f.err
    })
}

/// A bare SVM holding mainnet's mint_state exactly: total_minted 500, 500
/// bitmap bits set, authority = the real MINT_AUTHORITY.
fn mainnet_mint_state_svm(so: &str) -> (LiteSVM, Pubkey) {
    let mut svm = LiteSVM::new().with_sigverify(false);
    svm.add_program_from_file(PROGRAM_ID, so).unwrap();
    svm.airdrop(&MINT_AUTHORITY, 10_000_000_000).unwrap();
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
    svm.set_account(ms, Account { lamports, data: d, owner: PROGRAM_ID, executable: false, rent_epoch: 0 })
        .unwrap();
    (svm, ms)
}

fn total_minted(svm: &LiteSVM, ms: &Pubkey) -> Option<u32> {
    svm.get_account(ms)
        .filter(|a| a.data.len() >= 12)
        .map(|a| u32::from_le_bytes(a.data[8..12].try_into().unwrap()))
}

/// Every byte of `after` equals `before`, except is_mutable which went 1 -> 0.
fn assert_only_is_mutable_cleared(before_acc: &Account, after_acc: &Account) {
    let before = parse(&before_acc.data);
    let after = parse(&after_acc.data);
    assert!(before.is_mutable, "precondition: was mutable");
    let mut want = before.clone();
    want.is_mutable = false;
    assert_eq!(after, want, "a field other than is_mutable changed (full parse incl. tail bytes)");
    let diffs: Vec<usize> =
        (0..before_acc.data.len()).filter(|&i| before_acc.data[i] != after_acc.data[i]).collect();
    assert_eq!(diffs, vec![before.psh_offset + 1], "exactly one byte (is_mutable) may differ");
    assert_eq!(after_acc.lamports, before_acc.lamports);
    assert_eq!(after_acc.owner, before_acc.owner);
    assert_eq!(after_acc.data.len(), before_acc.data.len());
}

// ── Removed instructions ───────────────────────────────────────────────────

#[test]
fn removed_instructions_fail_fallback_not_found() {
    // Contrast: on the LIVE binary the authority can still close mint_state.
    let mut live = setup_with(false);
    let a = live.authority.insecure_clone();
    let ix = removed_ix(&live, "close_mint_state", a.pubkey());
    live.send(&[ix], &[&a]).expect("live binary: close_mint_state works (finding P1)");
    assert!(live.svm.get_account(&live.mint_state).map_or(true, |x| x.lamports == 0));

    // Freeze build: every removed instruction is gone.
    let mut env = setup();
    let auth = env.authority.insecure_clone();
    let ms_before = env.svm.get_account(&env.mint_state).unwrap();
    let member_before = env.raw_md(&env.member_mint);
    let coll_before = env.raw_md(&env.collection_mint);
    for name in REMOVED {
        let ix = removed_ix(&env, name, auth.pubkey());
        let mut signers = vec![&auth];
        let extra = Keypair::new();
        // create_collection / fulfill_mint list a fresh mint as a signer
        if ix.accounts.iter().filter(|m| m.is_signer).count() == 2 {
            let mut ix2 = ix.clone();
            for m in ix2.accounts.iter_mut() {
                if m.is_signer && m.pubkey != auth.pubkey() {
                    m.pubkey = extra.pubkey();
                }
            }
            signers.push(&extra);
            let err = env.send(&[ix2], &signers).unwrap_err();
            assert_eq!(custom(&err), Some(INSTRUCTION_FALLBACK_NOT_FOUND), "{name}: {err:?}");
        } else {
            let err = env.send(&[ix], &signers).unwrap_err();
            assert_eq!(custom(&err), Some(INSTRUCTION_FALLBACK_NOT_FOUND), "{name}: {err:?}");
        }
        println!("{name}: InstructionFallbackNotFound (101)");
    }
    assert_eq!(env.svm.get_account(&env.mint_state).unwrap(), ms_before, "mint_state untouched");
    assert_eq!(env.raw_md(&env.member_mint), member_before);
    assert_eq!(env.raw_md(&env.collection_mint), coll_before);
}

#[test]
fn sold_out_mint_state_cannot_be_reset_or_reopened() {
    // LIVE binary, real MINT_AUTHORITY (sigverify off): close + initialize
    // resets total_minted to 0. This is audit finding P1, reproduced.
    let (mut svm, ms) = mainnet_mint_state_svm(&live_so());
    let close = |ms| Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![AccountMeta::new(ms, false), AccountMeta::new(MINT_AUTHORITY, true)],
        data: disc("global", "close_mint_state").to_vec(),
    };
    let init = |ms| Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(ms, false),
            AccountMeta::new(MINT_AUTHORITY, true),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
        data: disc("global", "initialize").to_vec(),
    };
    send_as(&mut svm, &[close(ms)], &MINT_AUTHORITY).expect("live: close_mint_state");
    send_as(&mut svm, &[init(ms)], &MINT_AUTHORITY).expect("live: initialize");
    assert_eq!(total_minted(&svm, &ms), Some(0), "live binary reopens minting (P1)");
    println!("live 883f4b6: close_mint_state + initialize -> total_minted = 0 (P1 reproduced)");

    // FREEZE build, same key, same state: nothing resets or mints.
    let (mut svm, ms) = mainnet_mint_state_svm(&freeze_so());
    let before = svm.get_account(&ms).unwrap();
    for (label, ixs) in [
        ("close_mint_state", vec![close(ms)]),
        ("initialize", vec![init(ms)]),
        ("close_mint_state + initialize in one tx", vec![close(ms), init(ms)]),
    ] {
        let err = send_as(&mut svm, &ixs, &MINT_AUTHORITY).unwrap_err();
        assert_eq!(custom(&err), Some(INSTRUCTION_FALLBACK_NOT_FOUND), "{label}: {err:?}");
        println!("freeze: {label} -> 101");
    }
    // request_mint / fulfill_mint by anyone, and by the authority
    let env_like = Env {
        svm: LiteSVM::new(),
        authority: Keypair::new(),
        creator: Keypair::new(),
        mint_state: ms,
        collection_mint: Pubkey::new_unique(),
        member_mint: Pubkey::new_unique(),
    };
    let stranger = Pubkey::new_unique();
    svm.airdrop(&stranger, 10_000_000_000).unwrap();
    for who in [stranger, MINT_AUTHORITY] {
        for name in ["request_mint", "fulfill_mint", "create_collection"] {
            let ix = removed_ix(&env_like, name, who);
            let err = send_as(&mut svm, &[ix], &who).unwrap_err();
            assert_eq!(custom(&err), Some(INSTRUCTION_FALLBACK_NOT_FOUND), "{name}: {err:?}");
        }
    }
    println!("freeze: request_mint / fulfill_mint / create_collection -> 101 (stranger and authority)");
    let after = svm.get_account(&ms).unwrap();
    assert_eq!(after, before, "mint_state byte-identical");
    assert_eq!(total_minted(&svm, &ms), Some(500));
    let bits: u32 = after.data[45..109].iter().map(|b| b.count_ones()).sum();
    assert_eq!(bits, 500);
}

#[test]
fn member_supply_is_locked_by_master_edition() {
    // State the live program created: mint authority moved to the edition PDA,
    // so the old mint authority (our test key) cannot mint a second token.
    let mut env = setup();
    let auth = env.authority.insecure_clone();
    let mint = env.svm.get_account(&env.member_mint).unwrap();
    assert_eq!(&mint.data[0..4], &1u32.to_le_bytes(), "mint authority present");
    assert_eq!(Pubkey::try_from(&mint.data[4..36]).unwrap(), edition_pda(&env.member_mint));
    let mut mint_to = vec![7u8];
    mint_to.extend_from_slice(&1u64.to_le_bytes());
    let ix = Instruction {
        program_id: TOKEN,
        accounts: vec![
            AccountMeta::new(env.member_mint, false),
            AccountMeta::new(ata(&auth.pubkey(), &env.member_mint), false),
            AccountMeta::new_readonly(auth.pubkey(), true),
        ],
        data: mint_to,
    };
    assert!(env.send(&[ix], &[&auth]).is_err());
    assert_eq!(env.svm.get_account(&env.member_mint).unwrap().data[36..44], 1u64.to_le_bytes());
}

// ── lock_metadata ──────────────────────────────────────────────────────────

#[test]
fn lock_metadata_sets_only_is_mutable() {
    let mut env = setup();
    let auth = env.authority.insecure_clone();
    let before = env.raw_md(&env.member_mint);
    let coll_before = env.raw_md(&env.collection_mint);
    let cu = lock_member(&mut env, &auth).expect("lock_metadata");
    println!("lock_metadata compute units (incl. compute-budget ix): {cu}");
    let after = env.raw_md(&env.member_mint);
    assert_only_is_mutable_cleared(&before, &after);
    let md = parse(&after.data);
    assert_eq!(md.collection, Some((true, env.collection_mint)), "collection stays verified");
    assert!(md.creators.as_ref().unwrap()[0].verified, "creator stays verified");
    assert_eq!(env.raw_md(&env.collection_mint), coll_before, "collection NFT untouched");

    // Idempotent: locking again succeeds and changes nothing.
    lock_member(&mut env, &auth).expect("second lock is a no-op");
    assert_eq!(env.raw_md(&env.member_mint), after);

    // Dumps for tests/lock_metadata.offline.cjs
    let dir = format!("{}/target/metadata-dumps", env!("CARGO_MANIFEST_DIR"));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(format!("{dir}/lock_before.bin"), &before.data).unwrap();
    std::fs::write(format!("{dir}/lock_after.bin"), &after.data).unwrap();
}

#[test]
fn lock_after_uri_change_with_primary_sale_true_keeps_everything() {
    let mut env = setup();
    let auth = env.authority.insecure_clone();
    let mut acc = env.raw_md(&env.member_mint);
    let off = parse(&acc.data).psh_offset;
    acc.data[off] = 1;
    env.svm.set_account(metadata_pda(&env.member_mint), acc).unwrap();
    call(&mut env, &auth, NEW_URI).expect("uri moved first, as in the real sequence");
    let ix = update_royalty_ix(env.mint_state, auth.pubkey(), metadata_pda(&env.member_mint), 100, &[(env.creator.pubkey(), 100)]);
    env.send(&[ix], &[&auth]).expect("royalty set first");
    let before = env.raw_md(&env.member_mint);
    assert!(parse(&before.data).primary_sale_happened);
    lock_member(&mut env, &auth).expect("lock");
    let after = env.raw_md(&env.member_mint);
    assert_only_is_mutable_cleared(&before, &after);
    let md = parse(&after.data);
    assert_eq!(md.uri, NEW_URI);
    assert_eq!(md.seller_fee_basis_points, 100);
    assert!(md.primary_sale_happened);
}

#[test]
fn after_lock_uri_and_royalty_updates_are_refused() {
    let mut env = setup();
    let auth = env.authority.insecure_clone();
    lock_member(&mut env, &auth).expect("lock");
    let locked = env.raw_md(&env.member_mint);

    let err = call(&mut env, &auth, NEW_URI).unwrap_err();
    assert_eq!(custom(&err), Some(MPL_DATA_IS_IMMUTABLE), "update_token_uri: {err:?}");
    let err = call(&mut env, &auth, OLD_URI).unwrap_err();
    assert_eq!(custom(&err), Some(MPL_DATA_IS_IMMUTABLE), "revert to Vercel: {err:?}");
    let ix = update_royalty_ix(env.mint_state, auth.pubkey(), metadata_pda(&env.member_mint), 0, &[(auth.pubkey(), 100)]);
    let err = env.send(&[ix], &[&auth]).unwrap_err();
    assert_eq!(custom(&err), Some(MPL_DATA_IS_IMMUTABLE), "update_royalty: {err:?}");
    assert_eq!(env.raw_md(&env.member_mint), locked, "locked account byte-identical");
    println!("after lock: update_token_uri, revert and update_royalty -> Metaplex DataIsImmutable (59)");
}

#[test]
fn lock_rejects_wrong_or_unsigned_authority() {
    let mut env = setup();
    let before = env.raw_md(&env.member_mint);
    let impostor = Keypair::new();
    env.svm.airdrop(&impostor.pubkey(), 1_000_000_000).unwrap();
    let err = lock_member(&mut env, &impostor).unwrap_err();
    assert_eq!(custom(&err), Some(CONSTRAINT_HAS_ONE), "{err:?}");
    assert_eq!(env.raw_md(&env.member_mint), before);

    let mut ix = lock_ix(env.mint_state, env.authority.pubkey(), metadata_pda(&env.member_mint));
    ix.accounts[1].is_signer = false;
    let err = env.send(&[ix], &[&impostor]).unwrap_err();
    assert_eq!(custom(&err), Some(ACCOUNT_NOT_SIGNER), "{err:?}");
    assert_eq!(env.raw_md(&env.member_mint), before);

    // Still mutable: the real authority can still change the uri.
    let auth = env.authority.insecure_clone();
    call(&mut env, &auth, NEW_URI).expect("still mutable after the rejected locks");
}

#[test]
fn lock_rejects_non_metadata_account() {
    let mut env = setup();
    let auth = env.authority.insecure_clone();
    let mut fake = env.raw_md(&env.member_mint);
    fake.owner = PROGRAM_ID;
    let fake_key = Pubkey::new_unique();
    env.svm.set_account(fake_key, fake.clone()).unwrap();
    let ix = lock_ix(env.mint_state, auth.pubkey(), fake_key);
    assert!(env.send(&[ix], &[&auth]).is_err());
    assert_eq!(env.svm.get_account(&fake_key).unwrap(), fake);
}

#[test]
fn lock_collection_nft() {
    let mut env = setup();
    let auth = env.authority.insecure_clone();
    let coll = env.collection_mint;
    // repoint first, as the owner will (collection currently shares member #0's JSON)
    let ix = update_token_uri_ix(env.mint_state, auth.pubkey(), metadata_pda(&coll), NEW_URI);
    env.send(&[ix], &[&auth]).expect("collection uri update");
    let before = env.raw_md(&coll);
    let member_before = env.raw_md(&env.member_mint);
    assert!(parse(&before.data).collection_details.is_some(), "sized collection");
    lock(&mut env, &auth, &coll).expect("lock collection NFT");
    let after = env.raw_md(&coll);
    assert_only_is_mutable_cleared(&before, &after);
    assert_eq!(parse(&after.data).collection_details, parse(&before.data).collection_details, "size kept");
    assert_eq!(env.raw_md(&env.member_mint), member_before, "member untouched");

    let ix = update_token_uri_ix(env.mint_state, auth.pubkey(), metadata_pda(&coll), OLD_URI);
    let err = env.send(&[ix], &[&auth]).unwrap_err();
    assert_eq!(custom(&err), Some(MPL_DATA_IS_IMMUTABLE), "{err:?}");

    // The member can still be locked afterwards, and stays verified.
    let mb = env.raw_md(&env.member_mint);
    lock_member(&mut env, &auth).expect("lock member after collection");
    assert_only_is_mutable_cleared(&mb, &env.raw_md(&env.member_mint));
    assert_eq!(env.md(&env.member_mint).collection, Some((true, coll)));
}

// ── close_pending_mint (kept: 3 open pending_mint accounts on mainnet) ──────

#[test]
fn close_pending_mint_still_refunds_its_owner_only() {
    let mut env = setup();
    let minter = Keypair::new();
    let stranger = Keypair::new();
    env.svm.airdrop(&minter.pubkey(), 1_000_000_000).unwrap();
    env.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    let (pda, bump) = Pubkey::find_program_address(&[b"pending_mint", minter.pubkey().as_ref()], &PROGRAM_ID);
    let mut d = disc("account", "PendingMint").to_vec();
    d.extend_from_slice(minter.pubkey().as_ref());
    d.extend_from_slice(Pubkey::new_unique().as_ref());
    d.push(bump);
    d.extend_from_slice(&51_012_471u64.to_le_bytes());
    assert_eq!(d.len(), 81);
    let rent = env.svm.minimum_balance_for_rent_exemption(81);
    env.svm.set_account(pda, Account { lamports: rent, data: d, owner: PROGRAM_ID, executable: false, rent_epoch: 0 })
        .unwrap();
    let ix = |m: Pubkey| Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(Pubkey::find_program_address(&[b"pending_mint", m.as_ref()], &PROGRAM_ID).0, false),
            AccountMeta::new(m, true),
        ],
        data: disc("global", "close_pending_mint").to_vec(),
    };
    // A stranger can only address their own (non-existent) PDA.
    let err = env.send(&[ix(stranger.pubkey())], &[&stranger]).unwrap_err();
    assert_eq!(custom(&err), Some(ACCOUNT_NOT_INITIALIZED), "{err:?}");
    // Passing the minter's PDA with the stranger signing fails the seeds check.
    let mut bad = ix(minter.pubkey());
    bad.accounts[1] = AccountMeta::new(stranger.pubkey(), true);
    assert!(env.send(&[bad], &[&stranger]).is_err());
    assert!(env.svm.get_account(&pda).is_some_and(|a| a.lamports == rent));

    let bal = env.svm.get_balance(&minter.pubkey()).unwrap();
    env.send(&[ix(minter.pubkey())], &[&minter]).expect("minter reclaims rent");
    assert!(env.svm.get_account(&pda).map_or(true, |a| a.lamports == 0));
    let fee = 5_000;
    assert_eq!(env.svm.get_balance(&minter.pubkey()).unwrap(), bal + rent - fee);
}
