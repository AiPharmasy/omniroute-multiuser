# Quick Launch with Docker (Multi-User Mode)

This guide shows you how to launch OmniRoute in multi-user platform mode using a **single `docker run` command** — no docker-compose needed.

## Prerequisites

- Docker installed on your machine
- A Stripe account (optional — only needed for wallet top-ups and payouts)

## Step 1: Build the image

```bash
git clone https://github.com/AiPharmasy/omniroute-multiuser.git
cd omniroute-multiuser
docker build --target runner-base -t omniroute-multiuser .
```

This builds the lean image (~500 MB). If you need web-cookie providers (gemini-web, claude-web, claude-turnstile), use `runner-web` instead:

```bash
docker build --target runner-web -t omniroute-multiuser . # ~800 MB
```

Build takes ~5-10 minutes depending on your machine.

## Step 2: Run the container

```bash
docker run -d \
  --name omniroute \
  -p 20128:20128 \
  -v omniroute-data:/app/data \
  -e OMNIROUTE_MULTI_USER=true \
  -e JWT_SECRET=$(openssl rand -base64 48) \
  -e API_KEY_SECRET=$(openssl rand -hex 32) \
  -e INITIAL_PASSWORD=change-me-please \
  -e OMNIROUTE_MIN_REQUEST_FLOOR_USD=0.01 \
  -e STRIPE_SECRET_KEY=sk_test_your_key_here \
  -e STRIPE_WEBHOOK_SECRET=whsec_your_webhook_secret \
  omniroute-multiuser
```

### What each flag does

| Flag | Purpose |
|---|---|
| `-d` | Run in background (detached) |
| `--name omniroute` | Name the container for easy management |
| `-p 20128:20128` | Map container port 20128 to host |
| `-v omniroute-data:/app/data` | Persist SQLite database across restarts |
| `-e OMNIROUTE_MULTI_USER=true` | **Enable multi-user platform mode** |
| `-e JWT_SECRET=...` | Sign dashboard JWTs (generate a random value) |
| `-e API_KEY_SECRET=...` | Encrypt API keys at rest (generate a random value) |
| `-e INITIAL_PASSWORD=...` | Legacy admin password (still needed for fallback) |
| `-e OMNIROUTE_MIN_REQUEST_FLOOR_USD=0.01` | Pre-flight wallet gate ($0.01 minimum) |
| `-e STRIPE_SECRET_KEY=...` | Stripe API key (optional — leave empty to disable top-ups) |
| `-e STRIPE_WEBHOOK_SECRET=...` | Stripe webhook signing secret (optional) |

### Without Stripe (testing locally)

```bash
docker run -d \
  --name omniroute \
  -p 20128:20128 \
  -v omniroute-data:/app/data \
  -e OMNIROUTE_MULTI_USER=true \
  -e JWT_SECRET=$(openssl rand -base64 48) \
  -e API_KEY_SECRET=$(openssl rand -hex 32) \
  -e INITIAL_PASSWORD=change-me-please \
  omniroute-multiuser
```

## Step 3: Create the first admin user

1. Open `http://localhost:20128/register` in your browser
2. Enter your email, a display name, and a password (min 8 chars)
3. Click "Create account"
4. You'll be redirected to the dashboard

**The first user is created with role `user`.** To promote to admin:

```bash
docker exec omniroute node -e "
const Database = require('better-sqlite3');
const db = new Database('/app/data/storage.sqlite');
const result = db.prepare(\"UPDATE users SET role = 'admin' WHERE email = 'your-email@example.com'\").run();
console.log('Updated rows:', result.changes);
"
```

## Step 4: Verify it's working

```bash
# Check container is running
docker ps | grep omniroute

# Check logs
docker logs omniroute

# Health check
curl http://localhost:20128/api/monitoring/health
```

You should see `[STARTUP] Multi-user billing listener initialized` in the logs.

## Step 5: Start using it

### As a consumer
1. Top up your wallet at `/dashboard/wallet` (if Stripe is configured)
2. Create an API key at `/dashboard/api-manager`
3. Browse the marketplace at `/dashboard/marketplace`
4. Use the API key to call any provider

### As a provider
1. Add your provider connection at `/dashboard/providers`
2. Publish it to the marketplace (create a listing)
3. Earn credits when others use your provider
4. Request a payout at `/dashboard/wallet`

## Management commands

```bash
# Stop
docker stop omniroute

# Start again
docker start omniroute

# View logs (follow)
docker logs -f omniroute

# Restart
docker restart omniroute

# Remove (keeps data volume)
docker rm -f omniroute

# Remove data volume too (deletes all users, wallets, providers)
docker volume rm omniroute-data
```

## Update to a new version

```bash
cd omniroute-multiuser
git pull origin main
docker build --target runner-base -t omniroute-multiuser .
docker rm -f omniroute
# Re-run the docker run command from Step 2
```

Your data is preserved in the `omniroute-data` volume.

## Stripe webhook setup (optional)

If you configured Stripe for wallet top-ups:

1. Go to Stripe Dashboard -> Developers -> Webhooks
2. Add endpoint: `http://your-server:20128/api/webhooks/stripe`
3. Subscribe to events:
   - `checkout.session.completed`
   - `payout.paid`
   - `payout.failed`
4. Copy the signing secret (`whsec_...`)
5. Set it as `STRIPE_WEBHOOK_SECRET` in your docker run command

## Troubleshooting

### "Registration is disabled"
`OMNIROUTE_MULTI_USER` is not set to `true`. Check with:
```bash
docker exec omniroute printenv OMNIROUTE_MULTI_USER
```

### "Stripe is not configured"
`STRIPE_SECRET_KEY` is empty. Top-ups and payouts are disabled. Either set the env var or ignore (you can still manually seed wallets).

### Can't access the dashboard
Check the port mapping:
```bash
docker port omniroute
```

### Database errors after update
The migrations run automatically on startup. Check logs:
```bash
docker logs omniroute 2>&1 | grep -i migration
```

### Want to reset everything
```bash
docker rm -f omniroute
docker volume rm omniroute-data
# Re-run Step 2
```
