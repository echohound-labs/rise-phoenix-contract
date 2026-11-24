//! Owner decision (2026-11-24, follow-up 2): after the lock, the collection NFT token
//! goes into the "vault", the ATA owned by the mint_state PDA, with the same two
//! instructions vault_collection.cjs sends (ATA CreateIdempotent + SPL TransferChecked of 1).
//!
//! Control first: while a wallet holds the token it can BurnNft the collection NFT and
//! wipe its metadata (audit probe D). After the move into the vault, the former holder,
//! a stranger and every instruction of the freeze program fail to burn, transfer,
//! delegate or close it, on LiteSVM's Token program AND X1 mainnet's Token binary.
//!
//! Kept as the record of why the destination changed: with the incinerator's ATA, an
//! SPL Burn by ANYONE succeeds (SPL Token skips the owner check for accounts owned by
//! the incinerator or the system program).

mod common;
use common::*;
use solana_sdk::{message::Message, signature::Signature};

const INCINERATOR: Pubkey = pubkey!("1nc1nerator11111111111111111111111111111111");

fn create_idempotent_ix(payer: Pubkey, owner: Pubkey, mint: Pubkey) -> Instruction {
    Instruction {
        program_id: ATA,
        accounts: vec![
            AccountMeta::new(payer, true),
            AccountMeta::new(ata(&owner, &mint), false),
            AccountMeta::new_readonly(owner, false),
            AccountMeta::new_readonly(mint, false),
            AccountMeta::new_readonly(system_program::id(), false),
            AccountMeta::new_readonly(TOKEN, false),
        ],
        data: vec![1],
    }
}
fn transfer_checked_ix(source: Pubkey, mint: Pubkey, dest: Pubkey, owner: Pubkey) -> Instruction {
    let mut data = vec![12u8];
    data.extend_from_slice(&1u64.to_le_bytes());
    data.push(0);
    Instruction {
        program_id: TOKEN,
        accounts: vec![
            AccountMeta::new(source, false),
            AccountMeta::new_readonly(mint, false),
            AccountMeta::new(dest, false),
            AccountMeta::new_readonly(owner, true),
        ],
        data,
    }
}
fn spl_burn_ix(account: Pubkey, mint: Pubkey, owner: Pubkey) -> Instruction {
    let mut data = vec![8u8];
    data.extend_from_slice(&1u64.to_le_bytes());
    Instruction {
        program_id: TOKEN,
        accounts: vec![AccountMeta::new(account, false), AccountMeta::new(mint, false), AccountMeta::new_readonly(owner, true)],
        data,
    }
}
fn spl_approve_ix(account: Pubkey, delegate: Pubkey, owner: Pubkey) -> Instruction {
    let mut data = vec![4u8];
    data.extend_from_slice(&1u64.to_le_bytes());
    Instruction {
        program_id: TOKEN,
        accounts: vec![AccountMeta::new(account, false), AccountMeta::new_readonly(delegate, false), AccountMeta::new_readonly(owner, true)],
        data,
    }
}
fn spl_close_ix(account: Pubkey, dest: Pubkey, owner: Pubkey) -> Instruction {
    Instruction {
        program_id: TOKEN,
        accounts: vec![AccountMeta::new(account, false), AccountMeta::new(dest, false), AccountMeta::new_readonly(owner, true)],
        data: vec![9],
    }
}
/// Metaplex BurnNft (29) of the collection NFT itself (it belongs to no collection).
fn burn_nft_ix(owner: Pubkey, mint: Pubkey, token_account: Pubkey) -> Instruction {
    Instruction {
        program_id: MPL,
        accounts: vec![
            AccountMeta::new(metadata_pda(&mint), false),
            AccountMeta::new(owner, true),
            AccountMeta::new(mint, false),
            AccountMeta::new(token_account, false),
            AccountMeta::new(edition_pda(&mint), false),
            AccountMeta::new_readonly(TOKEN, false),
        ],
        data: vec![29],
    }
}
fn token_amount(env: &Env, acc: &Pubkey) -> Option<u64> {
    env.svm.get_account(acc).filter(|a| a.data.len() == 165).map(|a| u64::from_le_bytes(a.data[64..72].try_into().unwrap()))
}

#[test]
fn vault_address_is_pinned_and_off_curve() {
    let ms = mint_state_pda().0;
    assert_eq!(ms, pubkey!("7m8h2Rf5w4UzPqS9EVMVkHwaKhhfvrJiwoc8Qvapkxoh"));
    assert!(!ms.is_on_curve(), "a PDA: no secret key exists");
    assert_eq!(
        ata(&ms, &pubkey!("hzdZak4qN9bZ93ztu4bTBmDwx6F3XNyieFG5SQqCsJm")),
        pubkey!("4HTVWQUUa5gb4QKyytfhyRNzKevAxzKHevrM2vfJM3KB"),
        "the destination vault_collection.cjs pins"
    );
}

#[test]
fn incinerator_is_off_curve() {
    assert!(!INCINERATOR.is_on_curve(), "no ed25519 secret key exists for it");
    assert_eq!(
        ata(&INCINERATOR, &pubkey!("hzdZak4qN9bZ93ztu4bTBmDwx6F3XNyieFG5SQqCsJm")),
        pubkey!("HQSNbZZMNuJhQTXsWAZimfiT4PLyyAD5VM2zR23LZfpE"),
        "the destination follow-up 1 used (no longer used)"
    );
}

#[test]
fn control_holder_can_burn_the_collection_nft() {
    // Audit probe D, reproduced: this is the risk the incinerator removes.
    let mut env = setup();
    let auth = env.authority.insecure_clone();
    let coll = env.collection_mint;
    let held = ata(&auth.pubkey(), &coll);
    assert_eq!(token_amount(&env, &held), Some(1), "setup: the authority's ATA holds the collection token");
    env.send(&[burn_nft_ix(auth.pubkey(), coll, held)], &[&auth]).expect("holder burns the collection NFT");
    assert!(env.svm.get_account(&metadata_pda(&coll)).map_or(true, |a| a.data.iter().all(|b| *b == 0) || a.lamports == 0));
}

/// X1 mainnet's SPL Token binary (`solana program dump Tokenkeg…`, sha256 8190d3f7…f697;
/// its upgrade authority is NONE, so these rules are fixed). None = LiteSVM's bundled copy.
fn token_variants() -> [Option<String>; 2] {
    [None, Some(format!("{}/fixtures/spl_token_x1_mainnet.so", env!("CARGO_MANIFEST_DIR")))]
}

/// setup(), optionally with X1's Token program, then the script's move to the incinerator ATA.
fn moved(token_so: &Option<String>) -> (Env, Keypair, Pubkey, Pubkey, Pubkey) {
    let mut env = setup();
    if let Some(so) = token_so {
        env.svm.add_program_from_file(TOKEN, so).unwrap();
    }
    let auth = env.authority.insecure_clone();
    let coll = env.collection_mint;
    let source = ata(&auth.pubkey(), &coll);
    let dest = ata(&INCINERATOR, &coll);
    env.send(
        &[create_idempotent_ix(auth.pubkey(), INCINERATOR, coll), transfer_checked_ix(source, coll, dest, auth.pubkey())],
        &[&auth],
    )
    .expect("move to the incinerator ATA");
    assert_eq!(token_amount(&env, &dest), Some(1));
    assert_eq!(token_amount(&env, &source), Some(0));
    let d = env.svm.get_account(&dest).unwrap();
    assert_eq!(Pubkey::try_from(&d.data[32..64]).unwrap(), INCINERATOR, "owner");
    assert_eq!(&d.data[72..76], &[0, 0, 0, 0], "no delegate");
    assert_eq!(d.data[108], 1, "initialized, not frozen");
    assert_eq!(&d.data[129..133], &[0, 0, 0, 0], "no close authority");
    // Re-running the script's transaction: create is idempotent, the transfer fails (source empty).
    assert!(env
        .send(&[create_idempotent_ix(auth.pubkey(), INCINERATOR, coll), transfer_checked_ix(source, coll, dest, auth.pubkey())], &[&auth])
        .is_err());
    (env, auth, coll, source, dest)
}
fn mint_supply(env: &Env, mint: &Pubkey) -> u64 {
    u64::from_le_bytes(env.svm.get_account(mint).unwrap().data[36..44].try_into().unwrap())
}

#[test]
fn incinerator_ata_blocks_transfer_delegate_close_and_burnnft() {
    for tv in token_variants() {
        let (mut env, auth, coll, _source, dest) = moved(&tv);
        let md_before = env.raw_md(&coll);
        let dest_before = env.svm.get_account(&dest).unwrap();
        let stranger = Keypair::new();
        env.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
        for who in [&auth, &stranger] {
            let w = who.pubkey();
            let back = ata(&w, &coll);
            let _ = env.send(&[create_idempotent_ix(w, w, coll)], &[who]);
            assert!(env.send(&[transfer_checked_ix(dest, coll, back, w)], &[who]).is_err(), "transfer out");
            assert!(env.send(&[burn_nft_ix(w, coll, dest)], &[who]).is_err(), "Metaplex BurnNft (wipes metadata) needs the owner");
            assert!(env.send(&[spl_approve_ix(dest, w, w)], &[who]).is_err(), "approve a delegate");
            assert!(env.send(&[spl_close_ix(dest, w, w)], &[who]).is_err(), "close to self");
        }
        assert_eq!(env.svm.get_account(&dest).unwrap(), dest_before, "incinerator ATA unchanged");
        assert_eq!(env.raw_md(&coll), md_before, "collection metadata unchanged");

        // What transfer-proofing rests on: only the incinerator's own signature would move it.
        // With sigverify off (impossible on chain) a transfer "signed" by it succeeds.
        let mut svm = std::mem::replace(&mut env.svm, LiteSVM::new()).with_sigverify(false);
        svm.airdrop(&INCINERATOR, 1_000_000_000).unwrap();
        svm.expire_blockhash();
        let back = ata(&auth.pubkey(), &coll);
        let msg = Message::new_with_blockhash(&[transfer_checked_ix(dest, coll, back, INCINERATOR)], Some(&auth.pubkey()), &svm.latest_blockhash());
        let n = msg.header.num_required_signatures as usize;
        let tx = Transaction { signatures: (0..n).map(|_| Signature::new_unique()).collect(), message: msg };
        svm.send_transaction(tx).expect("only an incinerator signature could move it");
    }
}

/// FINDING (owner decision 4): SPL Token lets ANYONE burn tokens held by an account whose
/// owner is the incinerator (or the system program), with no signature from the owner
/// (`is_owned_by_system_program_or_incinerator` in process_burn), and then close the empty
/// account to the incinerator. So the incinerator ATA does NOT stop a burn of the token.
/// What it does stop: Metaplex BurnNft, which is what wipes the collection metadata (audit M3,
/// probe D). After a stranger's SPL burn, supply is 0 but the metadata, master edition and
/// collection size stay exactly as they were, and members stay verified.
#[test]
fn finding_anyone_can_spl_burn_a_token_held_by_the_incinerator() {
    for tv in token_variants() {
        let (mut env, _auth, coll, _source, dest) = moved(&tv);
        let md_before = env.raw_md(&coll);
        let ed_before = env.svm.get_account(&edition_pda(&coll)).unwrap();
        let member_before = env.raw_md(&env.member_mint);
        let stranger = Keypair::new();
        env.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();

        env.send(&[spl_burn_ix(dest, coll, stranger.pubkey())], &[&stranger]).expect("stranger SPL-burns the incinerator's token");
        assert_eq!(token_amount(&env, &dest), Some(0));
        assert_eq!(mint_supply(&env, &coll), 0, "collection NFT supply is now 0");
        // the empty account can be closed by anyone, but only to the incinerator
        assert!(env.send(&[spl_close_ix(dest, stranger.pubkey(), stranger.pubkey())], &[&stranger]).is_err());
        env.send(&[spl_close_ix(dest, INCINERATOR, stranger.pubkey())], &[&stranger]).expect("close to the incinerator");
        assert!(env.svm.get_account(&dest).map_or(true, |a| a.lamports == 0));

        assert_eq!(env.raw_md(&coll), md_before, "collection metadata untouched by the SPL burn");
        assert_eq!(env.svm.get_account(&edition_pda(&coll)).unwrap(), ed_before, "master edition untouched");
        assert_eq!(env.raw_md(&env.member_mint), member_before, "member untouched");
        assert_eq!(env.md(&env.member_mint).collection, Some((true, coll)), "member still verified");
        // Metaplex BurnNft can never run now (no token account holds 1).
        assert!(env.send(&[burn_nft_ix(stranger.pubkey(), coll, dest)], &[&stranger]).is_err());
        println!("token program {}: stranger burned it, supply 0, metadata/edition/members unchanged", tv.as_deref().unwrap_or("bundled"));
    }
}

/// THE SCRIPT'S PATH: the ATA owned by the mint_state PDA. mint_state is neither the
/// incinerator nor the system program, so SPL's permissionless burn does not apply, and no key
/// exists for a PDA. The freeze build has no token-program CPI at all (it only CPIs Metaplex
/// UpdateMetadataAccountsV2), so mint_state can never sign a transfer or burn; once the upgrade
/// authority is renounced that is permanent. Both token binaries.
#[test]
fn vault_mint_state_owned_ata_resists_burn_and_transfer() {
    for tv in token_variants() {
        let mut env = setup();
        if let Some(so) = &tv {
            env.svm.add_program_from_file(TOKEN, so).unwrap();
        }
        let auth = env.authority.insecure_clone();
        let coll = env.collection_mint;
        let ms = env.mint_state;
        let source = ata(&auth.pubkey(), &coll);
        let dest = ata(&ms, &coll);
        env.send(&[create_idempotent_ix(auth.pubkey(), ms, coll), transfer_checked_ix(source, coll, dest, auth.pubkey())], &[&auth])
            .expect("move to ATA(mint_state)");
        let before = env.svm.get_account(&dest).unwrap();
        let stranger = Keypair::new();
        env.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
        for who in [&auth, &stranger] {
            let w = who.pubkey();
            assert!(env.send(&[spl_burn_ix(dest, coll, w)], &[who]).is_err(), "SPL burn refused (owner is not the incinerator)");
            assert!(env.send(&[transfer_checked_ix(dest, coll, ata(&w, &coll), w)], &[who]).is_err());
            assert!(env.send(&[burn_nft_ix(w, coll, dest)], &[who]).is_err());
            assert!(env.send(&[spl_approve_ix(dest, w, w)], &[who]).is_err());
            assert!(env.send(&[spl_close_ix(dest, INCINERATOR, w)], &[who]).is_err());
        }
        assert_eq!(env.svm.get_account(&dest).unwrap(), before);
        assert_eq!(mint_supply(&env, &coll), 1);
    }
}

/// Every instruction of the freeze program, with the vault ATA where its writable account goes,
/// signed by the real authority: all fail and the vault is byte-identical. (The program has no
/// token CPI; its Metaplex CPI is refused because the vault is not a metadata account.)
#[test]
fn freeze_program_instructions_cannot_touch_the_vault() {
    let mut env = setup();
    let auth = env.authority.insecure_clone();
    let coll = env.collection_mint;
    let ms = env.mint_state;
    let source = ata(&auth.pubkey(), &coll);
    let vault = ata(&ms, &coll);
    env.send(&[create_idempotent_ix(auth.pubkey(), ms, coll), transfer_checked_ix(source, coll, vault, auth.pubkey())], &[&auth])
        .expect("move to the vault");
    let before = env.svm.get_account(&vault).unwrap();
    let with_vault = |data: Vec<u8>| Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new_readonly(ms, false),
            AccountMeta::new_readonly(auth.pubkey(), true),
            AccountMeta::new(vault, false),
            AccountMeta::new_readonly(MPL, false),
        ],
        data,
    };
    let mut uri = disc("global", "update_token_uri").to_vec();
    borsh_str(&mut uri, NEW_URI);
    let mut roy = disc("global", "update_royalty").to_vec();
    roy.extend_from_slice(&300u16.to_le_bytes());
    roy.extend_from_slice(&1u32.to_le_bytes());
    roy.extend_from_slice(auth.pubkey().as_ref());
    roy.push(100);
    for (what, ix) in [
        ("lock_metadata", with_vault(disc("global", "lock_metadata").to_vec())),
        ("update_token_uri", with_vault(uri)),
        ("update_royalty", with_vault(roy)),
        (
            "close_pending_mint",
            Instruction {
                program_id: PROGRAM_ID,
                accounts: vec![AccountMeta::new(vault, false), AccountMeta::new(auth.pubkey(), true)],
                data: disc("global", "close_pending_mint").to_vec(),
            },
        ),
    ] {
        assert!(env.send(&[ix], &[&auth]).is_err(), "{what} with the vault must fail");
        assert_eq!(env.svm.get_account(&vault).unwrap(), before, "{what}: vault unchanged");
    }
    assert_eq!(token_amount(&env, &vault), Some(1));
}
