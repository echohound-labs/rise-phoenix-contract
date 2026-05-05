use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::metadata::{
    create_metadata_accounts_v3,
    mpl_token_metadata::types::{Creator, DataV2},
    CreateMetadataAccountsV3, Metadata,
};
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount};

declare_id!("5QUVVnm1duiRazqa69KW9ZQhCCZcg5GBUKkUn5avA8Gb");

pub const TREASURY: Pubkey = pubkey!("Gowv5PDb7K4a5PwjubWegvBT4CDfjjJcG4QAZWa9yUob");
pub const MAX_SUPPLY: u32 = 500;
pub const MINT_PRICE: u64 = 10_000_000_000;
pub const BASE_URI: &str = "https://rise-phoenix-nft.vercel.app/api/metadata/";
pub const GEIGER_PROGRAM: Pubkey = pubkey!("2dQf9uaCzXewrDNLttmtzQmc3SmqfAHz3qahKQjtGQyY");

#[program]
pub mod rise_phoenix_contract {
    use super::*;

    pub fn close_pending_mint(ctx: Context<ClosePendingMint>) -> Result<()> {
        Ok(())
    }

    pub fn close_mint_state(ctx: Context<CloseMintState>) -> Result<()> {
        Ok(())
    }

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let state = &mut ctx.accounts.mint_state;
        state.total_minted = 0;
        state.authority = ctx.accounts.authority.key();
        state.bump = ctx.bumps.mint_state;
        Ok(())
    }

    // Step 1: Request randomness from Geiger Oracle
    pub fn request_mint(ctx: Context<RequestMint>) -> Result<()> {
        require!(
            ctx.accounts.mint_state.total_minted < MAX_SUPPLY,
            PhoenixError::SoldOut
        );

        // Build user seed from minter pubkey + slot
        let clock = Clock::get()?;
        let mut user_seed = [0u8; 32];
        user_seed[..32].copy_from_slice(&ctx.accounts.minter.key().to_bytes());
        user_seed[0] ^= (clock.slot & 0xff) as u8;

        // CPI to Geiger request_randomness
        let request_ix = anchor_lang::solana_program::instruction::Instruction {
            program_id: GEIGER_PROGRAM,
            accounts: vec![
                anchor_lang::solana_program::instruction::AccountMeta::new(ctx.accounts.oracle_state.key(), false),
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(ctx.accounts.entropy_pool.key(), false),
                anchor_lang::solana_program::instruction::AccountMeta::new(ctx.accounts.randomness_request.key(), false),
                anchor_lang::solana_program::instruction::AccountMeta::new(ctx.accounts.minter.key(), true),
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
            ],
            data: {
                let mut d = vec![213, 5, 173, 166, 37, 236, 31, 18]; // request_randomness discriminator
                d.extend_from_slice(&user_seed);
                d
            },
        };

        anchor_lang::solana_program::program::invoke(
            &request_ix,
            &[
                ctx.accounts.oracle_state.to_account_info(),
                ctx.accounts.entropy_pool.to_account_info(),
                ctx.accounts.randomness_request.to_account_info(),
                ctx.accounts.minter.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        // Store pending mint info
        let pending = &mut ctx.accounts.pending_mint;
        pending.minter = ctx.accounts.minter.key();
        pending.randomness_request = ctx.accounts.randomness_request.key();
        pending.bump = ctx.bumps.pending_mint;
        pending.slot_requested = clock.slot;

        Ok(())
    }

    // Step 2: Fulfill mint after randomness is ready
    pub fn fulfill_mint(ctx: Context<FulfillMint>) -> Result<()> {
        let total_minted = ctx.accounts.mint_state.total_minted;
        let bump = ctx.accounts.mint_state.bump;
        require!(total_minted < MAX_SUPPLY, PhoenixError::SoldOut);

        // Read random result from Geiger RandomnessRequest account
        let request_data = ctx.accounts.randomness_request.try_borrow_data()?;
        // Skip discriminator (8) + requester (32) + user_seed (32) = offset 72
        let result = &request_data[72..104];
        
        // Check status is Fulfilled (offset 104, status byte should be 1)
        require!(request_data[104] == 1, PhoenixError::RandomnessNotReady);

        // Use random bytes to pick NFT number from full range (0-499)
        let random_u32 = u32::from_le_bytes([result[0], result[1], result[2], result[3]]);
        let mut candidate = (random_u32 % MAX_SUPPLY) as usize;
        
        // Find first unminted slot starting from random candidate
        let mut mint_number = candidate as u32;
        for _ in 0..MAX_SUPPLY {
            let byte_idx = candidate / 64;
            let bit_idx = candidate % 64;
            let is_minted = (ctx.accounts.mint_state.minted_bitmap[byte_idx] & (1u64 << bit_idx)) != 0;
            
            if !is_minted {
                mint_number = candidate as u32;
                break;
            }
            candidate = (candidate + 1) % (MAX_SUPPLY as usize);
        }
        
        // Mark this NFT as minted in bitmap
        let byte_idx = mint_number as usize / 64;
        let bit_idx = mint_number as usize % 64;
        ctx.accounts.mint_state.minted_bitmap[byte_idx] |= 1u64 << bit_idx;

        drop(request_data);

        let seeds = &[b"mint_state_v2".as_ref(), &[bump]];
        let signer_seeds = &[&seeds[..]];

        // 1. Mint 1 token
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
        let name = format!("RISE Phoenix #{}", mint_number);
        let tier = if mint_number < 400 { "Ember" } else if mint_number < 475 { "Blaze" } else { "Genesis" };

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
                    address: TREASURY,
                    verified: false,
                    share: 100,
                }]),
                collection: None,
                uses: None,
            },
            true,
            true,
            None,
        )?;

        // 3. Transfer 10 XNT to treasury
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
        space = 8 + 4 + 32 + 1 + 64,  // Added 64 bytes for bitmap
        seeds = [b"mint_state_v2"],
        bump
    )]
    pub mint_state: Account<'info, MintState>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RequestMint<'info> {
    #[account(mut, seeds = [b"mint_state_v2"], bump = mint_state.bump)]
    pub mint_state: Account<'info, MintState>,
    #[account(mut)]
    pub minter: Signer<'info>,
    #[account(
        init,
        payer = minter,
        space = 8 + 32 + 32 + 1 + 8,
        seeds = [b"pending_mint", minter.key().as_ref()],
        bump
    )]
    pub pending_mint: Account<'info, PendingMint>,
    /// CHECK: Geiger oracle state PDA
    #[account(mut)]
    pub oracle_state: UncheckedAccount<'info>,
    /// CHECK: Geiger entropy pool PDA
    pub entropy_pool: UncheckedAccount<'info>,
    /// CHECK: Geiger randomness request PDA (created by Geiger program)
    #[account(mut)]
    pub randomness_request: UncheckedAccount<'info>,
    /// CHECK: Geiger program for CPI
    pub geiger_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FulfillMint<'info> {
    #[account(mut, seeds = [b"mint_state_v2"], bump = mint_state.bump)]
    pub mint_state: Account<'info, MintState>,
    #[account(mut)]
    pub minter: Signer<'info>,
    #[account(
        mut,
        seeds = [b"pending_mint", minter.key().as_ref()],
        bump = pending_mint.bump,
        close = minter
    )]
    pub pending_mint: Account<'info, PendingMint>,
    /// CHECK: Geiger randomness request - verified via pending_mint
    pub randomness_request: UncheckedAccount<'info>,
    #[account(
        init,
        payer = minter,
        mint::decimals = 0,
        mint::authority = mint_state,
        mint::freeze_authority = mint_state,
    )]
    pub nft_mint: Account<'info, Mint>,
    #[account(
        init,
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
    pub minted_bitmap: [u64; 8],  // 64 bytes = 512 bits (enough for 500 NFTs)
}

#[account]
pub struct PendingMint {
    pub minter: Pubkey,
    pub randomness_request: Pubkey,
    pub bump: u8,
    pub slot_requested: u64,
}

#[event]
pub struct MintEvent {
    pub mint_number: u32,
    pub tier: String,
    pub minter: Pubkey,
}


#[derive(Accounts)]
pub struct CloseMintState<'info> {
    #[account(
        mut,
        seeds = [b"mint_state_v2"],
        bump = mint_state.bump,
        close = authority
    )]
    pub mint_state: Account<'info, MintState>,
    #[account(mut)]
    pub authority: Signer<'info>,
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
}
