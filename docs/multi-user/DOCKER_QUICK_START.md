# Deploy with Docker (Multi-User Mode)

Launch OmniRoute as a multi-user platform in 3 commands. No docker-compose needed.

---

## Quick Deploy

```bash
# 1. Get the code
git clone https://github.com/AiPharmasy/omniroute-multiuser.git
cd omniroute-multiuser

# 2. Create your .env from template
cp .env.docker.example .env
# Edit .env — at minimum change JWT_SECRET and API_KEY_SECRET
nano .env

# 3. Build + Run
docker build --target runner-base -t omniroute-multiuser .
docker run -d \
  --name omniroute \
  -p 20128:20128 \
  -v omniroute-data:/app/data \
  --env-file .env \
  omniroute-multiuser
```

That's it. Open `http://localhost:20128/register` to create your first user.

---

## The .env File

Copy `.env.docker.example` to `.env` and fill in these values:

### Must change

```env
JWT_SECRET=<run: openssl rand -base64 48>
API_KEY_SECRET=<run: openssl rand -hex 32>
INITIAL_PASSWORD=<your-password>
```

### Multi-user settings (already set in template)

```env
OMNIROUTE_MULTI_USER=true
OMNIROUTE_DEFAULT_COMMISSION_RATE=0.10
OMNIROUTE_MIN_REQUEST_FLOOR_USD=0.01
```

### Stripe (optional — leave empty if you don't want payments yet)

```env
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PUBLISHABLE_KEY=pk_test_...
```

---

## After Launch

### Create the first admin

1. Go to `http://localhost:20128/register`
2. Sign up with your email + password
3. Promote to admin:
```bash
docker exec omniroute node -e "
const D=require('better-sqlite3');
const db=new D('/app/data/storage.sqlite');
const r=db.prepare(\"UPDATE users SET role='admin' WHERE email='YOUR_EMAIL@example.com'\").run();
console.log('Promoted:', r.changes, 'user(s)');
"
```

### Verify it's running

```bash
docker logs omniroute
# Look for: [STARTUP] Multi-user billing listener initialized

curl http://localhost:20128/api/monitoring/health
# Should return: {"status":"ok",...}
```

---

## Management

```bash
docker stop omniroute       # stop
docker start omniroute      # start
docker restart omniroute    # restart
docker logs -f omniroute    # follow logs
docker rm -f omniroute      # remove container (data stays)
docker volume rm omniroute-data  # nuke all data (users, wallets, everything)
```

---

## Update to new version

```bash
git pull origin main
docker build --target runner-base -t omniroute-multiuser .
docker rm -f omniroute
docker run -d --name omniroute -p 20128:20128 -v omniroute-data:/app/data --env-file .env omniroute-multiuser
```

Your users, wallets, and providers are preserved in the `omniroute-data` volume.

---

## Deploy to a VPS (remote server)

```bash
# On the VPS:
git clone https://github.com/AiPharmasy/omniroute-multiuser.git
cd omniroute-multiuser
cp .env.docker.example .env
# Edit .env with your secrets
nano .env

# Build + run
docker build --target runner-base -t omniroute-multiuser .
docker run -d \
  --name omniroute \
  -p 20128:20128 \
  -v omniroute-data:/app/data \
  --env-file .env \
  --restart unless-stopped \
  omniroute-multiuser

# Set up a reverse proxy (nginx/caddy) with TLS for production
# Point stripe webhooks to https://your-domain/api/webhooks/stripe
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| "Registration is disabled" | `OMNIROUTE_MULTI_USER` not set to `true` in `.env` |
| "Stripe is not configured" | `STRIPE_SECRET_KEY` is empty in `.env` — top-ups disabled |
| Can't access on port 20128 | Check `docker port omniroute` — port might be taken |
| Database migration errors | `docker logs omniroute 2>&1 \| grep -i migration` |
| Want to start fresh | `docker rm -f omniroute && docker volume rm omniroute-data` |
| Build fails on `stripe` | Run `git pull` and rebuild — stripe SDK was added to assembleStandalone |
