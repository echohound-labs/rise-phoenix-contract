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

use litesvm::LiteSVM;
use sha2::{Digest, Sha256};
use solana_sdk::{
    account::Account,
    compute_budget::ComputeBudgetInstruction,
    instruction::{AccountMeta, Instruction, InstructionError},
    pubkey,
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    system_instruction, system_program, sysvar,
    transaction::{Transaction, TransactionError},
};

const PROGRAM_ID: Pubkey = pubkey!("5QUVVnm1duiRazqa69KW9ZQhCCZcg5GBUKkUn5avA8Gb");
const MPL: Pubkey = pubkey!("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const TOKEN: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA: Pubkey = pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const COLLECTION_URI: &str = "https://rise-phoenix-nft.vercel.app/api/collection";
const OLD_URI: &str = "https://rise-phoenix-nft.vercel.app/api/metadata/7";
const NEW_URI: &str = "https://ipfs.example/ipfs/bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";

// Anchor error codes
const CONSTRAINT_HAS_ONE: u32 = 2001;
const ERR_EMPTY_URI: u32 = 6004;
const ERR_URI_TOO_LONG: u32 = 6005;

fn disc(prefix: &str, name: &str) -> [u8; 8] {
    let h = Sha256::digest(format!("{prefix}:{name}").as_bytes());
    h[..8].try_into().unwrap()
}
fn borsh_str(out: &mut Vec<u8>, s: &str) {
    out.extend_from_slice(&(s.len() as u32).to_le_bytes());
    out.extend_from_slice(s.as_bytes());
}
fn metadata_pda(mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"metadata", MPL.as_ref(), mint.as_ref()], &MPL).0
}
fn edition_pda(mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"metadata", MPL.as_ref(), mint.as_ref(), b"edition"], &MPL).0
}
fn ata(wallet: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[wallet.as_ref(), TOKEN.as_ref(), mint.as_ref()], &ATA).0
}
fn mint_state_pda() -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"mint_state_v2"], &PROGRAM_ID)
}

// ── Metaplex metadata parser (full layout, every field compared) ───────────

#[derive(Debug, Clone, PartialEq)]
struct Creator {
    address: Pubkey,
    verified: bool,
    share: u8,
}
#[derive(Debug, Clone, PartialEq)]
struct Md {
    key: u8,
    update_authority: Pubkey,
    mint: Pubkey,
    name: String,
    symbol: String,
    uri: String,
    seller_fee_basis_points: u16,
    creators: Option<Vec<Creator>>,
    primary_sale_happened: bool,
    is_mutable: bool,
    edition_nonce: Option<u8>,
    token_standard: Option<u8>,
    collection: Option<(bool, Pubkey)>,
    uses: Option<(u8, u64, u64)>,
    collection_details: Option<Vec<u8>>,
    /// every byte after collection_details (programmable_config + padding)
    tail: Vec<u8>,
    /// byte offset of primary_sale_happened, for the flip test
    psh_offset: usize,
    data_len: usize,
}

fn parse(d: &[u8]) -> Md {
    let mut o = 0usize;
    let u8_ = |o: &mut usize| {
        let v = d[*o];
        *o += 1;
        v
    };
    let pk = |o: &mut usize| {
        let v = Pubkey::try_from(&d[*o..*o + 32]).unwrap();
        *o += 32;
        v
    };
    let u16_ = |o: &mut usize| {
        let v = u16::from_le_bytes(d[*o..*o + 2].try_into().unwrap());
        *o += 2;
        v
    };
    let u32_ = |o: &mut usize| {
        let v = u32::from_le_bytes(d[*o..*o + 4].try_into().unwrap());
        *o += 4;
        v
    };
    let u64_ = |o: &mut usize| {
        let v = u64::from_le_bytes(d[*o..*o + 8].try_into().unwrap());
        *o += 8;
        v
    };
    let s = |o: &mut usize| {
        let n = u32::from_le_bytes(d[*o..*o + 4].try_into().unwrap()) as usize;
        *o += 4;
        let v = String::from_utf8(d[*o..*o + n].to_vec()).unwrap();
        *o += n;
        v.trim_end_matches('\0').to_string()
    };
    let key = u8_(&mut o);
    let update_authority = pk(&mut o);
    let mint = pk(&mut o);
    let name = s(&mut o);
    let symbol = s(&mut o);
    let uri = s(&mut o);
    let seller_fee_basis_points = u16_(&mut o);
    let creators = if u8_(&mut o) == 1 {
        let n = u32_(&mut o);
        Some(
            (0..n)
                .map(|_| Creator { address: pk(&mut o), verified: u8_(&mut o) == 1, share: u8_(&mut o) })
                .collect(),
        )
    } else {
        None
    };
    let psh_offset = o;
    let primary_sale_happened = u8_(&mut o) == 1;
    let is_mutable = u8_(&mut o) == 1;
    let edition_nonce = if u8_(&mut o) == 1 { Some(u8_(&mut o)) } else { None };
    let token_standard = if u8_(&mut o) == 1 { Some(u8_(&mut o)) } else { None };
    let collection = if u8_(&mut o) == 1 { Some((u8_(&mut o) == 1, pk(&mut o))) } else { None };
    let uses = if u8_(&mut o) == 1 { Some((u8_(&mut o), u64_(&mut o), u64_(&mut o))) } else { None };
    let collection_details = if u8_(&mut o) == 1 {
        let v = d[o..o + 9].to_vec(); // variant byte + 8 bytes (size / padding)
        o += 9;
        Some(v)
    } else {
        None
    };
    Md {
        key,
        update_authority,
        mint,
        name,
        symbol,
        uri,
        seller_fee_basis_points,
        creators,
        primary_sale_happened,
        is_mutable,
        edition_nonce,
        token_standard,
        collection,
        uses,
        collection_details,
        tail: d[o..].to_vec(),
        psh_offset,
        data_len: d.len(),
    }
}

// ── Harness ────────────────────────────────────────────────────────────────

struct Env {
    svm: LiteSVM,
    authority: Keypair,
    creator: Keypair,
    mint_state: Pubkey,
    collection_mint: Pubkey,
    member_mint: Pubkey,
}

impl Env {
    fn send(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> Result<u64, TransactionError> {
        self.svm.expire_blockhash();
        let mut all = vec![ComputeBudgetInstruction::set_compute_unit_limit(1_400_000)];
        all.extend_from_slice(ixs);
        let tx = Transaction::new_signed_with_payer(
            &all,
            Some(&signers[0].pubkey()),
            signers,
            self.svm.latest_blockhash(),
        );
        match self.svm.send_transaction(tx) {
            Ok(meta) => Ok(meta.compute_units_consumed),
            Err(f) => {
                eprintln!("tx failed: {:?}\n{}", f.err, f.meta.logs.join("\n"));
                Err(f.err)
            }
        }
    }
    fn md(&self, mint: &Pubkey) -> Md {
        parse(&self.svm.get_account(&metadata_pda(mint)).unwrap().data)
    }
    fn raw_md(&self, mint: &Pubkey) -> Account {
        self.svm.get_account(&metadata_pda(mint)).unwrap()
    }
}

fn update_token_uri_ix(mint_state: Pubkey, authority: Pubkey, metadata: Pubkey, uri: &str) -> Instruction {
    let mut data = disc("global", "update_token_uri").to_vec();
    borsh_str(&mut data, uri);
    Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new_readonly(mint_state, false),
            AccountMeta::new_readonly(authority, true),
            AccountMeta::new(metadata, false),
            AccountMeta::new_readonly(MPL, false),
        ],
        data,
    }
}

fn update_royalty_ix(mint_state: Pubkey, authority: Pubkey, metadata: Pubkey, bps: u16, creators: &[(Pubkey, u8)]) -> Instruction {
    let mut data = disc("global", "update_royalty").to_vec();
    data.extend_from_slice(&bps.to_le_bytes());
    data.extend_from_slice(&(creators.len() as u32).to_le_bytes());
    for (a, s) in creators {
        data.extend_from_slice(a.as_ref());
        data.push(*s);
    }
    Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new_readonly(mint_state, false),
            AccountMeta::new_readonly(authority, true),
            AccountMeta::new(metadata, false),
            AccountMeta::new_readonly(MPL, false),
        ],
        data,
    }
}

fn custom(e: &TransactionError) -> Option<u32> {
    match e {
        TransactionError::InstructionError(_, InstructionError::Custom(c)) => Some(*c),
        _ => None,
    }
}

fn setup() -> Env {
    let mut svm = LiteSVM::new();
    let root = env!("CARGO_MANIFEST_DIR");
    svm.add_program_from_file(MPL, format!("{root}/fixtures/mpl_token_metadata.so")).unwrap();
    svm.add_program_from_file(PROGRAM_ID, format!("{root}/../../target/deploy/rise_phoenix_contract.so"))
        .unwrap();

    let authority = Keypair::new();
    let creator = Keypair::new(); // stands in for the treasury creator
    svm.airdrop(&authority.pubkey(), 100_000_000_000).unwrap();
    svm.airdrop(&creator.pubkey(), 1_000_000_000).unwrap();

    // mint_state as it is on mainnet: sold out, authority = our test key.
    let (mint_state, bump) = mint_state_pda();
    let mut ms = disc("account", "MintState").to_vec();
    ms.extend_from_slice(&500u32.to_le_bytes());
    ms.extend_from_slice(authority.pubkey().as_ref());
    ms.push(bump);
    ms.extend_from_slice(&[0xffu8; 64]);
    assert_eq!(ms.len(), 8 + 4 + 32 + 1 + 64);
    let lamports = svm.minimum_balance_for_rent_exemption(ms.len());
    svm.set_account(mint_state, Account { lamports, data: ms, owner: PROGRAM_ID, executable: false, rent_epoch: 0 })
        .unwrap();

    let mut env = Env {
        svm,
        authority,
        creator,
        mint_state,
        collection_mint: Pubkey::default(),
        member_mint: Pubkey::default(),
    };

    // 1. Collection NFT via the program's own create_collection.
    let cm = Keypair::new();
    let mut data = disc("global", "create_collection").to_vec();
    borsh_str(&mut data, COLLECTION_URI);
    let ix = Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new_readonly(mint_state, false),
            AccountMeta::new(env.authority.pubkey(), true),
            AccountMeta::new(cm.pubkey(), true),
            AccountMeta::new(ata(&env.authority.pubkey(), &cm.pubkey()), false),
            AccountMeta::new(metadata_pda(&cm.pubkey()), false),
            AccountMeta::new(edition_pda(&cm.pubkey()), false),
            AccountMeta::new_readonly(TOKEN, false),
            AccountMeta::new_readonly(ATA, false),
            AccountMeta::new_readonly(MPL, false),
            AccountMeta::new_readonly(system_program::id(), false),
            AccountMeta::new_readonly(sysvar::rent::id(), false),
        ],
        data,
    };
    let auth = env.authority.insecure_clone();
    env.send(&[ix], &[&auth, &cm]).expect("create_collection");
    env.collection_mint = cm.pubkey();

    // 2. Member mint: decimals 0, mint authority = test key for now, freeze = mint_state.
    let mm = Keypair::new();
    let a = env.authority.pubkey();
    let rent = env.svm.minimum_balance_for_rent_exemption(82);
    let mut init_mint = vec![20u8, 0];
    init_mint.extend_from_slice(a.as_ref());
    init_mint.push(1);
    init_mint.extend_from_slice(mint_state.as_ref());
    let member_ata = ata(&a, &mm.pubkey());
    let mut mint_to = vec![7u8];
    mint_to.extend_from_slice(&1u64.to_le_bytes());

    // Metaplex CreateMetadataAccountV3 (33): update authority = mint_state (not a signer).
    let mut cmd = vec![33u8];
    borsh_str(&mut cmd, "RISE Phoenix #7");
    borsh_str(&mut cmd, "RISE");
    borsh_str(&mut cmd, OLD_URI);
    cmd.extend_from_slice(&100u16.to_le_bytes());
    cmd.push(1); // creators: Some
    cmd.extend_from_slice(&1u32.to_le_bytes());
    cmd.extend_from_slice(env.creator.pubkey().as_ref());
    cmd.push(0); // unverified until SignMetadata
    cmd.push(100);
    cmd.push(0); // collection: None
    cmd.push(0); // uses: None
    cmd.push(1); // is_mutable
    cmd.push(0); // collection_details: None

    // SetAuthority(MintTokens) -> mint_state, like fulfill_mint's mints.
    let mut set_auth = vec![6u8, 0, 1];
    set_auth.extend_from_slice(mint_state.as_ref());

    let ixs = vec![
        system_instruction::create_account(&a, &mm.pubkey(), rent, 82, &TOKEN),
        Instruction { program_id: TOKEN, accounts: vec![AccountMeta::new(mm.pubkey(), false)], data: init_mint },
        Instruction {
            program_id: ATA,
            accounts: vec![
                AccountMeta::new(a, true),
                AccountMeta::new(member_ata, false),
                AccountMeta::new_readonly(a, false),
                AccountMeta::new_readonly(mm.pubkey(), false),
                AccountMeta::new_readonly(system_program::id(), false),
                AccountMeta::new_readonly(TOKEN, false),
            ],
            data: vec![],
        },
        Instruction {
            program_id: TOKEN,
            accounts: vec![
                AccountMeta::new(mm.pubkey(), false),
                AccountMeta::new(member_ata, false),
                AccountMeta::new_readonly(a, true),
            ],
            data: mint_to,
        },
        Instruction {
            program_id: MPL,
            accounts: vec![
                AccountMeta::new(metadata_pda(&mm.pubkey()), false),
                AccountMeta::new_readonly(mm.pubkey(), false),
                AccountMeta::new_readonly(a, true),
                AccountMeta::new(a, true),
                AccountMeta::new_readonly(mint_state, false),
                AccountMeta::new_readonly(system_program::id(), false),
                AccountMeta::new_readonly(sysvar::rent::id(), false),
            ],
            data: cmd,
        },
        Instruction {
            program_id: TOKEN,
            accounts: vec![AccountMeta::new(mm.pubkey(), false), AccountMeta::new_readonly(a, true)],
            data: set_auth,
        },
    ];
    env.send(&ixs, &[&auth, &mm]).expect("member mint + metadata");
    env.member_mint = mm.pubkey();

    // 3. Creator verifies itself (Metaplex SignMetadata = 7), as the treasury did on mainnet.
    let creator = env.creator.insecure_clone();
    let sign = Instruction {
        program_id: MPL,
        accounts: vec![
            AccountMeta::new(metadata_pda(&mm.pubkey()), false),
            AccountMeta::new_readonly(creator.pubkey(), true),
        ],
        data: vec![7],
    };
    env.send(&[sign], &[&auth, &creator]).expect("sign metadata");

    // 4. Master edition via the program's create_member_master_edition.
    let ix = Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new_readonly(mint_state, false),
            AccountMeta::new(a, true),
            AccountMeta::new(metadata_pda(&mm.pubkey()), false),
            AccountMeta::new(mm.pubkey(), false),
            AccountMeta::new(edition_pda(&mm.pubkey()), false),
            AccountMeta::new_readonly(MPL, false),
            AccountMeta::new_readonly(TOKEN, false),
            AccountMeta::new_readonly(system_program::id(), false),
            AccountMeta::new_readonly(sysvar::rent::id(), false),
        ],
        data: disc("global", "create_member_master_edition").to_vec(),
    };
    env.send(&[ix], &[&auth]).expect("create_member_master_edition");

    // 5. Set + verify the sized collection via the program's verify_collection.
    let ix = Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new_readonly(mint_state, false),
            AccountMeta::new(a, true),
            AccountMeta::new(metadata_pda(&mm.pubkey()), false),
            AccountMeta::new_readonly(env.collection_mint, false),
            AccountMeta::new(metadata_pda(&env.collection_mint), false),
            AccountMeta::new_readonly(edition_pda(&env.collection_mint), false),
            AccountMeta::new_readonly(MPL, false),
        ],
        data: disc("global", "verify_collection").to_vec(),
    };
    env.send(&[ix], &[&auth]).expect("verify_collection");

    // Sanity: the starting state mirrors a live member.
    let md = env.md(&env.member_mint);
    assert_eq!(md.update_authority, mint_state);
    assert_eq!(md.uri, OLD_URI);
    assert_eq!(md.collection, Some((true, env.collection_mint)));
    assert_eq!(md.creators, Some(vec![Creator { address: env.creator.pubkey(), verified: true, share: 100 }]));
    assert!(md.is_mutable);
    assert!(env.svm.get_account(&edition_pda(&env.member_mint)).is_some());
    env
}

fn call(env: &mut Env, signer: &Keypair, uri: &str) -> Result<u64, TransactionError> {
    let ix = update_token_uri_ix(env.mint_state, signer.pubkey(), metadata_pda(&env.member_mint), uri);
    env.send(&[ix], &[signer])
}

/// Assert `after` equals `before` in every field except `uri`.
fn assert_only_uri_changed(before: &Md, after: &Md, want_uri: &str) {
    assert_eq!(after.uri, want_uri);
    let mut b = before.clone();
    b.uri = want_uri.to_string();
    assert_eq!(&b, after, "a field other than uri changed");
}

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
