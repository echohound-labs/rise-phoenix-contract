//! Owner decision 4 (audit M3): after the lock, the collection NFT token goes to
//! the incinerator's ATA. These tests show what that does and does not prevent,
//! with the same two instructions incinerate_collection.cjs sends
//! (ATA CreateIdempotent + SPL TransferChecked of 1).
//!
//! Control first: while a wallet holds the token it can burn the collection NFT
//! (audit probe D). After the move, the former holder, a stranger and the
//! freeze authority path all fail; only a signature by the incinerator itself
//! would work (shown with sigverify off), and no such signature can exist: the
//! address is off the ed25519 curve.

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
fn incinerator_is_off_curve() {
    assert!(!INCINERATOR.is_on_curve(), "no ed25519 secret key exists for it");
    assert_eq!(
        ata(&INCINERATOR, &pubkey!("hzdZak4qN9bZ93ztu4bTBmDwx6F3XNyieFG5SQqCsJm")),
        pubkey!("HQSNbZZMNuJhQTXsWAZimfiT4PLyyAD5VM2zR23LZfpE"),
        "the destination incinerate_collection.cjs uses"
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
fn after_the_move_nobody_can_transfer_delegate_close_or_metaplex_burn() {
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

/// Alternative for the owner (not what the script does): an ATA owned by the mint_state PDA.
/// mint_state is neither the incinerator nor the system program, so SPL's permissionless burn
/// does not apply, and no key exists for a PDA. The freeze build has no token-program CPI at all
/// (it only CPIs Metaplex UpdateMetadataAccountsV2), so mint_state can never sign a transfer or
/// burn; once the upgrade authority is renounced that is permanent. Both token binaries.
#[test]
fn alternative_mint_state_owned_ata_resists_burn_and_transfer() {
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
