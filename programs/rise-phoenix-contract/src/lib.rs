use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::metadata::{
    create_metadata_accounts_v3,
    mpl_token_metadata::types::{Creator, DataV2},
    CreateMetadataAccountsV3, Metadata,
};
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount};

declare_id!("5QUVVnm1duiRazqa69KW9ZQhCCZcg5GBUKkUn5avA8Gb");

pub const TREASURY: Pubkey = pubkey!("DBvfCPxj2gSo4dbHxwMrLRhy9fCmbHLrWJUDkUny8hBG");
pub const MAX_SUPPLY: u32 = 500;
pub const MINT_PRICE: u64 = 10_000_000_000;
pub const BASE_URI: &str = "https://rise-phoenix-nft.vercel.app/api/metadata/";

#[program]
pub mod rise_phoenix_contract {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let state = &mut ctx.accounts.mint_state;
        state.total_minted = 0;
        state.authority = ctx.accounts.authority.key();
        state.bump = ctx.bumps.mint_state;
        Ok(())
    }

    pub fn mint_phoenix(ctx: Context<MintPhoenix>) -> Result<()> {
        let total_minted = ctx.accounts.mint_state.total_minted;
        let bump = ctx.accounts.mint_state.bump;
        require!(total_minted < MAX_SUPPLY, PhoenixError::SoldOut);

        let mint_number = total_minted;
        let seeds = &[b"mint_state".as_ref(), &[bump]];
        let signer_seeds = &[&seeds[..]];

        // 1. Mint 1 token to minter ATA
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.nft_mint.to_account_info(),
                    to: ctx.accounts.minter_ata.to_account_info(),
                    authority: ctx.accounts.mint_state.to_account_info(),
                },
                signer_seeds,
            ),
            1,
        )?;

        // 2. Create metadata
        let uri = format!("{}{}", BASE_URI, mint_number);
        let name = format!("RISE Phoenix #{}", mint_number + 1);
        let tier = if mint_number < 400 {
            "Ember"
        } else if mint_number < 475 {
            "Blaze"
        } else {
            "Genesis"
        };

        create_metadata_accounts_v3(
            CpiContext::new_with_signer(
                ctx.accounts.token_metadata_program.to_account_info(),
                CreateMetadataAccountsV3 {
                    metadata: ctx.accounts.metadata.to_account_info(),
                    mint: ctx.accounts.nft_mint.to_account_info(),
                    mint_authority: ctx.accounts.mint_state.to_account_info(),
                    payer: ctx.accounts.minter.to_account_info(),
                    update_authority: ctx.accounts.mint_state.to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                    rent: ctx.accounts.rent.to_account_info(),
                },
                signer_seeds,
            ),
            DataV2 {
                name,
                symbol: "RISE".to_string(),
                uri,
                seller_fee_basis_points: 500,
                creators: Some(vec![Creator {
                    address: ctx.accounts.mint_state.key(),
                    verified: true,
                    share: 100,
                }]),
                collection: None,
                uses: None,
            },
            true,
            true,
            None,
        )?;

        // 3. Transfer 10 XNT to treasury LAST
        let transfer_ix = anchor_lang::solana_program::system_instruction::transfer(
            &ctx.accounts.minter.key(),
            &ctx.accounts.treasury.key(),
            MINT_PRICE,
        );
        anchor_lang::solana_program::program::invoke(
            &transfer_ix,
            &[
                ctx.accounts.minter.to_account_info(),
                ctx.accounts.treasury.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        // 4. Increment counter
        ctx.accounts.mint_state.total_minted += 1;

        emit!(MintEvent {
            mint_number,
            tier: tier.to_string(),
            minter: ctx.accounts.minter.key(),
        });

        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + 4 + 32 + 1,
        seeds = [b"mint_state"],
        bump
    )]
    pub mint_state: Account<'info, MintState>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct MintPhoenix<'info> {
    #[account(
        mut,
        seeds = [b"mint_state"],
        bump = mint_state.bump
    )]
    pub mint_state: Account<'info, MintState>,
    #[account(mut)]
    pub minter: Signer<'info>,
    #[account(
        init,
        payer = minter,
        mint::decimals = 0,
        mint::authority = mint_state,
        mint::freeze_authority = mint_state,
    )]
    pub nft_mint: Account<'info, Mint>,
    #[account(
        init_if_needed,
        payer = minter,
        associated_token::mint = nft_mint,
        associated_token::authority = minter,
    )]
    pub minter_ata: Account<'info, TokenAccount>,
    /// CHECK: Metaplex metadata PDA
    #[account(mut)]
    pub metadata: UncheckedAccount<'info>,
    /// CHECK: treasury wallet
    #[account(mut, address = TREASURY)]
    pub treasury: AccountInfo<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub token_metadata_program: Program<'info, Metadata>,
    pub rent: Sysvar<'info, Rent>,
}

#[account]
pub struct MintState {
    pub total_minted: u32,
    pub authority: Pubkey,
    pub bump: u8,
}

#[event]
pub struct MintEvent {
    pub mint_number: u32,
    pub tier: String,
    pub minter: Pubkey,
}

#[error_code]
pub enum PhoenixError {
    #[msg("All 500 phoenixes have been minted")]
    SoldOut,
}
