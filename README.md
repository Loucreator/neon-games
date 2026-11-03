# NEON GAMES — Production Website

Node.js + Express + PostgreSQL + Backblaze B2.

## Requirements
- Node.js 20 or newer
- PostgreSQL database (the current deployment uses the existing public.users / public.games / public.downloads tables)
- Backblaze B2 S3-compatible bucket

## Environment variables
Configure these in Render (or your hosting provider), not in source control:
- `DATABASE_URL`
- `SESSION_SECRET` (long random value)
- `B2_BUCKET_NAME`, `B2_ENDPOINT`, `B2_REGION`, `B2_KEY_ID`, `B2_APPLICATION_KEY`
- `MAX_GAME_FILE_MB` (optional; default 2048)
- `BATTLE_PASS_PRICE_DIAMONDS` (optional; default 500)
- `ENABLE_D17_RECHARGE=false` for the initial admin-only launch
- `D17_RECEIVER_NAME`, `D17_RECEIVER_PHONE`, `D17_INSTRUCTIONS` (only needed when enabling D17 requests)

Never commit or send `.env` files or private credentials. Rotate any credential that was accidentally exposed outside your private environment.

## Install and run locally
```bash
npm install
npm run dev
```

## Required database migration
Before deploying this version, run the additive, repeatable migration once against the same PostgreSQL database used by the website:

```bash
npm run migrate:neon
```

On Render, open the service Shell and run the command there after the updated files and environment variables are available. The migration adds the Diamonds wallet ledger, manual D17 request queue, one-time game-link codes, revocable game tokens, and Battle Pass progression tables. It does not delete or rewrite existing users, games, or downloads. Back up the database first.

## Diamonds workflow
- Initial launch: keep `ENABLE_D17_RECHARGE=false`. Admins sign in, open Dashboard, enter a player's registered email and Diamonds amount, then credit the wallet. Each grant is recorded in the wallet ledger.
- Later D17 phase: set `ENABLE_D17_RECHARGE=true` and configure the receiver details. Players submit the amount sent and an image proof. An admin must verify the actual payment independently, then approve the request and enter the Diamonds amount to credit. Approval is atomic and each request can only be credited once.
- D17 proof images are stored in the private B2 bucket under `wallet-proofs/`.

## NEON BRAWL account linking
1. Player signs in to the website and opens Wallet.
2. Website generates a one-time 8-character code that expires after 5 minutes.
3. Player enters the website HTTPS URL and code in NEON BRAWL.
4. The code is exchanged once for a revocable 90-day game token. The game never receives the player's website password or any server secret.
5. Diamonds, purchases, XP and rewards are validated and stored server-side.

## Battle Pass economy (initial season)
- Premium pass price defaults to 500 NEON Diamonds; change `BATTLE_PASS_PRICE_DIAMONDS` on the host before launch if needed.
- A completed CPU match grants 20 XP, with a 100 XP daily cap. Local 2-player matches do not grant XP.
- Each 100 XP advances a level, capped at level 10.
- Free track: 10 Diamonds at levels 2, 4, 6, 8 and 10.
- Premium track: an additional 15 Diamonds at those milestones, including retroactive premium rewards when the pass is purchased after reaching a milestone.
- Premium Pass unlocks the NEON AURA cyan palette in the PC game. XP is casual progression and is not an anti-cheat-secured ranked result.

## Security notes
- Never embed database, B2, or session secrets in the Godot game.
- Game bearer tokens are stored as hashes server-side and can be revoked by unlinking the account.
- Wallet balance changes are performed in PostgreSQL transactions and written to an immutable-style transaction ledger.
- D17 proof is not automatic payment confirmation; an admin must verify it before crediting.
