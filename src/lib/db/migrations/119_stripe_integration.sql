-- Migration 119: Stripe integration tables
--
-- Tracks top-up sessions (Checkout Session → wallet credit) and payout requests
-- (provider withdrawal). Idempotency is enforced via stripe_event_id UNIQUE.

CREATE TABLE IF NOT EXISTS stripe_topup_intents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  stripe_checkout_session_id TEXT UNIQUE,
  stripe_payment_intent_id TEXT,
  amount_usd REAL NOT NULL CHECK (amount_usd > 0),
  currency TEXT NOT NULL DEFAULT 'usd',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed', 'refunded')),
  wallet_transaction_id TEXT,
  failure_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_stripe_topup_user ON stripe_topup_intents(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_stripe_topup_session ON stripe_topup_intents(stripe_checkout_session_id);
CREATE INDEX IF NOT EXISTS idx_stripe_topup_status ON stripe_topup_intents(status);

CREATE TABLE IF NOT EXISTS stripe_payout_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  amount_usd REAL NOT NULL CHECK (amount_usd > 0),
  currency TEXT NOT NULL DEFAULT 'usd',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_transit', 'paid', 'failed', 'canceled')),
  stripe_payout_id TEXT,
  stripe_transfer_id TEXT,
  wallet_transaction_id TEXT,
  failure_reason TEXT,
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_stripe_payout_user ON stripe_payout_requests(user_id, requested_at);
CREATE INDEX IF NOT EXISTS idx_stripe_payout_status ON stripe_payout_requests(status);

CREATE TABLE IF NOT EXISTS stripe_event_log (
  stripe_event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  payload TEXT,
  processed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_stripe_event_type ON stripe_event_log(event_type, processed_at);
