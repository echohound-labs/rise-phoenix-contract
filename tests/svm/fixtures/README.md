# Fixtures

| File | sha256 | Source |
|---|---|---|
| `mpl_token_metadata.so` | `ba9cfaf061402f894a71a04cb522e04a6a9920f01eb98635dde97af71f8d757f` | Metaplex Token Metadata (`metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s`). Copied from `~/forge-launch-f4/tests/fixtures/programs/`, which took it from Magic Eden's MMM test deps. Programmable-NFT-era build (v1.13+). Used only by these offline LiteSVM tests. It is **not** a dump of the X1 mainnet Metaplex deployment, so the mainnet pilot on one token is still the authoritative check. |
| `rise_phoenix_live_883f4b6.so` | `815119aa57755c2b80478a9de5e22b9cffbb91cac33017d72bf3c040db7892df` | `anchor build` of commit `883f4b6`, 427,816 B. Byte-identical to the X1 mainnet program as dumped on 2026-11-23 (audit `rise-update-token-uri-audit-fable.md`). `setup()` builds the test state with this binary (it still has `create_collection`, `create_member_master_edition`, `verify_collection`), then upgrades in place to the freeze build, the same order as on mainnet. Also used to reproduce audit finding P1 (close + re-initialise `mint_state`) as a contrast. |
