# Deploy with Docker (Multi-User Mode)

Launch OmniRoute as a multi-user platform. No docker-compose needed.

---

## Quick Deploy

```bash
# 1. Get the code
git clone https://github.com/AiPharmasy/omniroute-multiuser.git
cd omniroute-multiuser

# 2. Create your .env from template
cp .env.docker.example .env
nano .env  # change JWT_SECRET, API_KEY_SECRET, INITIAL_PASSWORD

# 3. Build + Run
docker build -f Dockerfile.multiuser -t omniroute-multiuser .
docker run -d \
  --name omniroute \
  -p 20128:20128 \
  -v omniroute-data:/app/data \
  --env-file .env \
  omniroute-multiuser
```

Open `http://localhost:20128/register` to create your first user.

---

## Build fails with "OOMKilled" / "Not enough memory"?

If your Docker host has less than 4GB RAM, the standard Dockerfile will fail.
Use `Dockerfile.multiuser` instead (it's optimized for low-memory builds):

```bash
docker build -f Dockerfile.multiuser -t omniroute-multiuser .
```

This uses a 2048MB heap limit during build instead of 4096MB.

If it STILL fails (e.g. on a 1GB VPS), add swap:

```bash
# Create 2GB swap on the host
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile

# Now rebuild
docker build -f Dockerfile.multiuser -t omniroute-multiuser .
```

---

## The .env File

Copy `.env.docker.example` to `.env` and fill in:

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

### Stripe (optional)

```env
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

Leave Stripe empty if you don't want payments yet. You can always add it later.

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
```

---

## Management

```bash
docker stop omniroute       # stop
docker start omniroute      # start
docker restart omniroute    # restart
docker logs -f omniroute    # follow logs
docker rm -f omniroute      # remove container (data stays in volume)
docker volume rm omniroute-data  # delete ALL data (users, wallets, providers)
```

---

## Update to new version

```bash
git pull origin main
docker build -f Dockerfile.multiuser -t omniroute-multiuser .
docker rm -f omniroute
docker run -d --name omniroute -p 20128:20128 -v omniroute-data:/app/data --env-file .env omniroute-multiuser
```

Data is preserved in the `omniroute-data` volume.

---

## Deploy to a VPS

```bash
# On the VPS:
git clone https://github.com/AiPharmasy/omniroute-multiuser.git
cd omniroute-multiuser
cp .env.docker.example .env
nano .env

# Build + run (use Dockerfile.multiuser for low-RAM VPS)
docker build -f Dockerfile.multiuser -t omniroute-multiuser .
docker run -d \
  --name omniroute \
  -p 20128:20128 \
  -v omniroute-data:/app/data \
  --env-file .env \
  --restart unless-stopped \
  omniroute-multiuser

# Set up nginx/caddy with TLS for production
# Point Stripe webhooks to https://your-domain/api/webhooks/stripe
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Build: OOMKilled | Use `Dockerfile.multiuser` (lower memory) or add swap |
| "Registration is disabled" | `OMNIROUTE_MULTI_USER` not set to `true` in `.env` |
| "Stripe is not configured" | `STRIPE_SECRET_KEY` is empty — top-ups disabled (that's OK) |
| Can't access port 20128 | Check `docker port omniroute` — port might be taken |
| Database errors | `docker logs omniroute 2>&1 \| grep -i migration` |
| Want to start fresh | `docker rm -f omniroute && docker volume rm omniroute-data` |
