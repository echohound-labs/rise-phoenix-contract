const anchor = require("@coral-xyz/anchor");
const { PublicKey, Keypair, Connection } = require("@solana/web3.js");
const { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } = require("@solana/spl-token");
const fs = require("fs");
const path = require("path");

async function main() {
  const connection = new Connection("https://rpc.testnet.x1.xyz", "confirmed");
  
  const walletKeypair = Keypair.fromSecretKey(
    Buffer.from(JSON.parse(fs.readFileSync(
      path.join(process.env.HOME, ".config/solana/rise-mint-authority.json")
    )))
  );

  const wallet = new anchor.Wallet(walletKeypair);
  const provider = new anchor.AnchorProvider(connection, wallet, {});
  anchor.setProvider(provider);

  const idl = JSON.parse(fs.readFileSync(
    path.join(__dirname, "../target/idl/rise_phoenix_contract.json")
  ));

  const programId = new PublicKey("5QUVVnm1duiRazqa69KW9ZQhCCZcg5GBUKkUn5avA8Gb");
  const program = new anchor.Program(idl, provider);

  const [mintStatePDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("mint_state")],
    programId
  );

  // Generate a new NFT mint keypair
  const nftMintKeypair = Keypair.generate();

  // Derive metadata PDA
  const METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
  const [metadataPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), METADATA_PROGRAM_ID.toBuffer(), nftMintKeypair.publicKey.toBuffer()],
    METADATA_PROGRAM_ID
  );

  // Derive minter ATA
  const minterAta = getAssociatedTokenAddressSync(
    nftMintKeypair.publicKey,
    wallet.publicKey
  );

  const TREASURY = new PublicKey("DBvfCPxj2gSo4dbHxwMrLRhy9fCmbHLrWJUDkUny8hBG");

  console.log("Minting phoenix...");
  console.log("NFT Mint:", nftMintKeypair.publicKey.toBase58());
  console.log("Metadata PDA:", metadataPDA.toBase58());

  const tx = await program.methods
    .mintPhoenix()
    .accounts({
      mintState: mintStatePDA,
      minter: wallet.publicKey,
      nftMint: nftMintKeypair.publicKey,
      minterAta,
      metadata: metadataPDA,
      treasury: TREASURY,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
      tokenMetadataProgram: METADATA_PROGRAM_ID,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    })
    .signers([nftMintKeypair])
    .rpc();

  console.log("✅ Minted! Tx:", tx);
}

main().catch(console.error);
