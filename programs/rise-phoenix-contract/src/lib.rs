use anchor_lang::prelude::*;
use anchor_spl::metadata::{
    mpl_token_metadata::accounts::Metadata as MetadataAccount,
    mpl_token_metadata::types::{Creator, DataV2},
    update_metadata_accounts_v2, Metadata, UpdateMetadataAccountsV2,
};

declare_id!("5QUVVnm1duiRazqa69KW9ZQhCCZcg5GBUKkUn5avA8Gb");

// FREEZE BUILD. The collection is sold out (500/500 in mint_state, every
// member and the collection NFT has a max-supply-0 Master Edition). This build
// keeps only what a finished collection needs:
//   * close_pending_mint  - lets the three wallets with an abandoned
//                           pending_mint on mainnet reclaim their rent
//   * update_royalty      - unchanged
//   * update_token_uri    - unchanged
//   * lock_metadata       - one-way: sets is_mutable = false on a metadata
//                           account whose update authority is mint_state
// Removed for good (any call now fails with InstructionFallbackNotFound):
// close_mint_state, initialize, request_mint, fulfill_mint, create_collection,
// verify_collection, create_member_master_edition. Nothing in this program can
// create mint_state, reset it, mint a token or create a collection any more.

#[program]
pub mod rise_phoenix_contract {
    use super::*;

    pub fn close_pending_mint(ctx: Context<ClosePendingMint>) -> Result<()> {
        Ok(())
    }

    /// ── CERT: authority-gated royalty/creator update (ported from capy) ──
    /// Rewrites only `seller_fee_basis_points` + the creators list; every other
    /// field (name/symbol/uri/collection/uses) is copied forward unchanged, so
    /// the verified collection membership is preserved.
    ///
    /// `verified` is never taken from args. A creator already verified on the
    /// metadata keeps its flag; a new creator (e.g. the treasury) starts
    /// unverified and must sign separately via Metaplex `SignMetadata`.
    ///
    /// The 80 members whose current verified creator is the `mint_state` PDA are
    /// handled here: the PDA is also the update authority signing this CPI, and
    /// Metaplex only protects *other* creators' verified flags, so dropping the
    /// PDA creator is allowed.
    pub fn update_royalty(
        ctx: Context<UpdateRoyalty>,
        seller_fee_basis_points: u16,
        creators: Vec<CreatorArg>,
    ) -> Result<()> {
        require!(seller_fee_basis_points <= 10_000, PhoenixError::InvalidRoyalty);
        require!(
            !creators.is_empty() && creators.len() <= 5,
            PhoenixError::InvalidCreators
        );
        let total: u32 = creators.iter().map(|c| c.share as u32).sum();
        require!(total == 100, PhoenixError::InvalidCreators);

        let bump = ctx.accounts.mint_state.bump;
        let seeds = &[b"mint_state_v2".as_ref(), &[bump]];
        let signer = &[&seeds[..]];

        let cur = MetadataAccount::try_from(&ctx.accounts.metadata.to_account_info())?;
        let trim = |s: &str| s.trim_end_matches('\0').to_string();

        let existing = cur.creators.clone().unwrap_or_default();
        let new_creators: Vec<Creator> = creators
            .iter()
            .map(|c| Creator {
                address: c.address,
                verified: existing.iter().any(|e| e.address == c.address && e.verified),
                share: c.share,
            })
            .collect();

        update_metadata_accounts_v2(
            CpiContext::new_with_signer(
                ctx.accounts.token_metadata_program.to_account_info(),
                UpdateMetadataAccountsV2 {
                    metadata: ctx.accounts.metadata.to_account_info(),
                    update_authority: ctx.accounts.mint_state.to_account_info(),
                },
                signer,
            ),
            None,
            Some(DataV2 {
                name: trim(&cur.name),
                symbol: trim(&cur.symbol),
                uri: trim(&cur.uri),
                seller_fee_basis_points,
                creators: Some(new_creators),
                collection: cur.collection.clone(),
                uses: cur.uses.clone(),
            }),
            None,
            None,
        )?;

        Ok(())
    }

    /// ── CERT: authority-gated URI repoint (ported from capy) ──
    /// Reads the CURRENT on-chain metadata and copies every field forward
    /// unchanged except `uri`: name, symbol, seller_fee_basis_points, creators
    /// (with their verified flags), collection (with its verified flag) and uses.
    /// DataV2 is never rebuilt from source, so the verified collection membership
    /// and the update_royalty result are preserved exactly.
    /// `new_update_authority`, `primary_sale_happened` and `is_mutable` are passed
    /// as None, which Metaplex treats as "leave unchanged".
    pub fn update_token_uri(ctx: Context<UpdateTokenUri>, new_uri: String) -> Result<()> {
        require!(!new_uri.is_empty(), PhoenixError::EmptyUri);
        require!(
            new_uri.len() <= anchor_spl::metadata::mpl_token_metadata::MAX_URI_LENGTH,
            PhoenixError::UriTooLong
        );

        let bump = ctx.accounts.mint_state.bump;
        let seeds = &[b"mint_state_v2".as_ref(), &[bump]];
        let signer = &[&seeds[..]];

        let cur = MetadataAccount::try_from(&ctx.accounts.metadata.to_account_info())?;
        let trim = |s: &str| s.trim_end_matches('\0').to_string();

        update_metadata_accounts_v2(
            CpiContext::new_with_signer(
                ctx.accounts.token_metadata_program.to_account_info(),
                UpdateMetadataAccountsV2 {
                    metadata: ctx.accounts.metadata.to_account_info(),
                    update_authority: ctx.accounts.mint_state.to_account_info(),
                },
                signer,
            ),
            None,
            Some(DataV2 {
                name: trim(&cur.name),
                symbol: trim(&cur.symbol),
                uri: new_uri,
                seller_fee_basis_points: cur.seller_fee_basis_points,
                creators: cur.creators.clone(),
                collection: cur.collection.clone(),
                uses: cur.uses.clone(),
            }),
            None,
            None,
        )?;

        Ok(())
    }

    /// ── FREEZE: one-way metadata lock ──
    /// Calls Metaplex UpdateMetadataAccountsV2 with data = None,
    /// new_update_authority = None, primary_sale_happened = None and
    /// is_mutable = Some(false). Metaplex then refuses any later data update
    /// (update_token_uri, update_royalty) on this account, from anyone,
    /// forever: is_mutable can only ever go from true to false.
    /// Same gate as update_token_uri; works on members and the collection NFT.
    /// Calling it on an already-locked account succeeds and changes nothing.
    pub fn lock_metadata(ctx: Context<LockMetadata>) -> Result<()> {
        let bump = ctx.accounts.mint_state.bump;
        let seeds = &[b"mint_state_v2".as_ref(), &[bump]];
        let signer = &[&seeds[..]];

        update_metadata_accounts_v2(
            CpiContext::new_with_signer(
                ctx.accounts.token_metadata_program.to_account_info(),
                UpdateMetadataAccountsV2 {
                    metadata: ctx.accounts.metadata.to_account_info(),
                    update_authority: ctx.accounts.mint_state.to_account_info(),
                },
                signer,
            ),
            None,
            None,
            None,
            Some(false),
        )?;

        Ok(())
    }
}

#[derive(Accounts)]
pub struct UpdateTokenUri<'info> {
    #[account(seeds = [b"mint_state_v2"], bump = mint_state.bump, has_one = authority)]
    pub mint_state: Account<'info, MintState>,
    pub authority: Signer<'info>,
    /// CHECK: metadata PDA, validated by the Metaplex CPI
    #[account(mut)]
    pub metadata: UncheckedAccount<'info>,
    pub token_metadata_program: Program<'info, Metadata>,
}

#[derive(Accounts)]
pub struct UpdateRoyalty<'info> {
    #[account(seeds = [b"mint_state_v2"], bump = mint_state.bump, has_one = authority)]
    pub mint_state: Account<'info, MintState>,
    pub authority: Signer<'info>,
    /// CHECK: metadata PDA, validated by the Metaplex CPI
    #[account(mut)]
    pub metadata: UncheckedAccount<'info>,
    pub token_metadata_program: Program<'info, Metadata>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CreatorArg {
    pub address: Pubkey,
    pub share: u8,
}

#[derive(Accounts)]
pub struct LockMetadata<'info> {
    #[account(seeds = [b"mint_state_v2"], bump = mint_state.bump, has_one = authority)]
    pub mint_state: Account<'info, MintState>,
    pub authority: Signer<'info>,
    /// CHECK: metadata PDA, validated by the Metaplex CPI
    #[account(mut)]
    pub metadata: UncheckedAccount<'info>,
    pub token_metadata_program: Program<'info, Metadata>,
}

#[account]
pub struct MintState {
    pub total_minted: u32,
    pub authority: Pubkey,
    pub bump: u8,
    pub minted_bitmap: [u64; 8],  // 64 bytes = 512 bits (enough for 500 NFTs)
}

#[account]
pub struct PendingMint {
    pub minter: Pubkey,
    pub randomness_request: Pubkey,
    pub bump: u8,
    pub slot_requested: u64,
}

#[derive(Accounts)]
pub struct ClosePendingMint<'info> {
    #[account(
        mut,
        seeds = [b"pending_mint", minter.key().as_ref()],
        bump = pending_mint.bump,
        close = minter
    )]
    pub pending_mint: Account<'info, PendingMint>,
    #[account(mut)]
    pub minter: Signer<'info>,
}

#[error_code]
pub enum PhoenixError {
    #[msg("All 500 phoenixes have been minted")]
    SoldOut,
    #[msg("Randomness not yet fulfilled by Geiger Oracle")]
    RandomnessNotReady,
    #[msg("Royalty must be <= 10000 bps")]
    InvalidRoyalty,
    #[msg("Creators must be 1-5 entries with shares summing to 100")]
    InvalidCreators,
    #[msg("URI must not be empty")]
    EmptyUri,
    #[msg("URI exceeds the Metaplex limit of 200 bytes")]
    UriTooLong,
}
