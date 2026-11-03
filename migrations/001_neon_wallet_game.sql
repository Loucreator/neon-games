-- NEON GAMES wallet and game-account integration (safe to run more than once)
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS diamonds BIGINT NOT NULL DEFAULT 0;
ALTER TABLE public.users ALTER COLUMN diamonds SET DEFAULT 0;
UPDATE public.users SET diamonds = 0 WHERE diamonds IS NULL;
ALTER TABLE public.users ALTER COLUMN diamonds SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_diamonds_nonnegative'
  ) THEN
    ALTER TABLE public.users
      ADD CONSTRAINT users_diamonds_nonnegative CHECK (diamonds >= 0);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.wallet_transactions (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  entry_type VARCHAR(40) NOT NULL,
  amount BIGINT NOT NULL,
  balance_after BIGINT NOT NULL CHECK (balance_after >= 0),
  description VARCHAR(180) NOT NULL,
  created_by INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
  idempotency_key VARCHAR(160) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS wallet_transactions_user_created_idx
  ON public.wallet_transactions(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.diamond_recharge_requests (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  amount_tnd NUMERIC(10,3) NOT NULL CHECK (amount_tnd > 0),
  proof_key TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  admin_note VARCHAR(300),
  reviewed_by INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  credited_diamonds BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS recharge_requests_status_created_idx
  ON public.diamond_recharge_requests(status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS one_pending_recharge_per_user_idx
  ON public.diamond_recharge_requests(user_id) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS public.game_login_codes (
  code_hash CHAR(64) PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.game_api_tokens (
  token_hash CHAR(64) PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS game_api_tokens_user_idx
  ON public.game_api_tokens(user_id, expires_at);

CREATE TABLE IF NOT EXISTS public.game_player_profiles (
  user_id INTEGER PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  xp INTEGER NOT NULL DEFAULT 0 CHECK (xp >= 0),
  pass_level INTEGER NOT NULL DEFAULT 1 CHECK (pass_level >= 1),
  premium_pass BOOLEAN NOT NULL DEFAULT FALSE,
  season_id VARCHAR(40) NOT NULL DEFAULT 'NEON_S1',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.game_xp_events (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  match_id VARCHAR(100) NOT NULL,
  xp_awarded INTEGER NOT NULL DEFAULT 0 CHECK (xp_awarded >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, match_id)
);
CREATE INDEX IF NOT EXISTS game_xp_events_user_day_idx
  ON public.game_xp_events(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.game_pass_rewards (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  season_id VARCHAR(40) NOT NULL,
  pass_level INTEGER NOT NULL,
  reward_type VARCHAR(20) NOT NULL CHECK (reward_type IN ('free','premium')) ,
  diamonds BIGINT NOT NULL CHECK (diamonds > 0),
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, season_id, pass_level, reward_type)
);
