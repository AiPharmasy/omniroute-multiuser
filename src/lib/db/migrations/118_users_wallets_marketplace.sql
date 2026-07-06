-- Migration 116: Multi-user platform foundation
--
-- Introduces a real User entity (replacing the single shared management password),
-- per-user wallet/billing with double-entry ledger, commission settings, and a
-- marketplace for publishing provider connections as pay-as-you-go.
--
-- All existing rows are backfilled to a single "system default" user so legacy
-- single-user installs keep working unchanged when OMNIROUTE_MULTI_USER is unset.

-- ───────────────────── Users & credentials ─────────────────────

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'provider', 'admin')),
  is_active INTEGER NOT NULL DEFAULT 1,
  is_email_verified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

CREATE TABLE IF NOT EXISTS user_credentials (
  user_id TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_algo TEXT NOT NULL DEFAULT 'bcrypt',
  password_updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS user_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_jti TEXT UNIQUE,
  issued_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  user_agent TEXT,
  ip_address TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_jti ON user_sessions(token_jti);

-- ───────────────────── Owner scoping on business tables ─────────────────────

ALTER TABLE provider_connections ADD COLUMN owner_user_id TEXT NOT NULL DEFAULT 'system';
ALTER TABLE provider_connections ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0;
ALTER TABLE provider_connections ADD COLUMN marketplace_listing_id TEXT;

ALTER TABLE api_keys ADD COLUMN owner_user_id TEXT NOT NULL DEFAULT 'system';

ALTER TABLE cli_access_tokens ADD COLUMN owner_user_id TEXT NOT NULL DEFAULT 'system';

ALTER TABLE combos ADD COLUMN owner_user_id TEXT NOT NULL DEFAULT 'system';

ALTER TABLE quota_pools ADD COLUMN owner_user_id TEXT NOT NULL DEFAULT 'system';
ALTER TABLE quota_pools ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0;

ALTER TABLE quota_groups ADD COLUMN owner_user_id TEXT NOT NULL DEFAULT 'system';

ALTER TABLE key_groups ADD COLUMN owner_user_id TEXT NOT NULL DEFAULT 'system';

ALTER TABLE domain_budgets ADD COLUMN owner_user_id TEXT NOT NULL DEFAULT 'system';

ALTER TABLE usage_history ADD COLUMN consumer_user_id TEXT;
ALTER TABLE usage_history ADD COLUMN provider_owner_user_id TEXT;

ALTER TABLE call_logs ADD COLUMN consumer_user_id TEXT;
ALTER TABLE call_logs ADD COLUMN provider_owner_user_id TEXT;

ALTER TABLE domain_cost_history ADD COLUMN consumer_user_id TEXT;
ALTER TABLE domain_cost_history ADD COLUMN provider_owner_user_id TEXT;

-- ───────────────────── Wallets & ledger ─────────────────────

CREATE TABLE IF NOT EXISTS wallets (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  balance_credits REAL NOT NULL DEFAULT 0 CHECK (balance_credits >= 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  held_credits REAL NOT NULL DEFAULT 0 CHECK (held_credits >= 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (owner_user_id)
);

CREATE INDEX IF NOT EXISTS idx_wallets_owner ON wallets(owner_user_id);

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id TEXT PRIMARY KEY,
  wallet_id TEXT NOT NULL,
  counterparty_wallet_id TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('credit', 'debit')),
  amount REAL NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  reason TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  usage_history_id INTEGER,
  marketplace_listing_id TEXT,
  idempotency_key TEXT UNIQUE,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (wallet_id) REFERENCES wallets(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_wallet_tx_wallet ON wallet_transactions(wallet_id, created_at);
CREATE INDEX IF NOT EXISTS idx_wallet_tx_idem ON wallet_transactions(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_wallet_tx_reason ON wallet_transactions(reason_code, created_at);

-- ───────────────────── Commission settings ─────────────────────

CREATE TABLE IF NOT EXISTS commission_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  commission_rate REAL NOT NULL DEFAULT 0.10 CHECK (commission_rate >= 0 AND commission_rate <= 1),
  min_payout_usd REAL NOT NULL DEFAULT 10.0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by TEXT
);

INSERT OR IGNORE INTO commission_settings (id, commission_rate, min_payout_usd)
VALUES (1, 0.10, 10.0);

-- ───────────────────── Marketplace listings ─────────────────────

CREATE TABLE IF NOT EXISTS marketplace_listings (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT,
  owner_user_id TEXT NOT NULL,
  connection_id TEXT,
  quota_pool_id TEXT,
  pricing_model TEXT NOT NULL DEFAULT 'per_token' CHECK (pricing_model IN ('per_token', 'per_request', 'flat')),
  price_per_1k_input_tokens_usd REAL NOT NULL DEFAULT 0,
  price_per_1k_output_tokens_usd REAL NOT NULL DEFAULT 0,
  price_per_request_usd REAL NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  is_featured INTEGER NOT NULL DEFAULT 0,
  category TEXT,
  tags TEXT,
  total_requests INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  average_rating REAL,
  rating_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_marketplace_active ON marketplace_listings(is_active, created_at);
CREATE INDEX IF NOT EXISTS idx_marketplace_owner ON marketplace_listings(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_slug ON marketplace_listings(slug);

-- ───────────────────── Backfill the system default user ─────────────────────

INSERT OR IGNORE INTO users (id, email, display_name, role, is_active, is_email_verified)
VALUES ('system', 'system@omniroute.local', 'System Default', 'admin', 1, 1);

INSERT OR IGNORE INTO users (id, email, display_name, role, is_active, is_email_verified)
VALUES ('platform', 'platform@omniroute.local', 'Platform Wallet', 'admin', 1, 1);

INSERT OR IGNORE INTO wallets (id, owner_user_id, balance_credits, currency)
VALUES ('wallet-system', 'system', 0, 'USD');

INSERT OR IGNORE INTO wallets (id, owner_user_id, balance_credits, currency)
VALUES ('wallet-platform', 'platform', 0, 'USD');

INSERT OR IGNORE INTO key_value (namespace, key, value)
VALUES ('settings', 'multiUserEnabled', 'false');
