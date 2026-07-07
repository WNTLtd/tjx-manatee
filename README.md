# Manatee

Manatee is a local-first web app for company mentors and mentees to register, match, and manage mentorship relationships.

## Features

- Mentor, mentee, or both-role self-registration with immediate login
- Admin login (default username/email: `admin`, password: `admin`)
- Role dashboards:
  - Admin: manage locations, functions, end reasons, SMTP settings, BCC logging address, archive mentorships for one selected mentor, view/export relationship history, review email audit lines, and list/delete non-admin users
  - Mentor: set location, select multiple functions, toggle availability, accept/decline mentee requests with personal messages, end live mentorships
  - Mentee: set location, filter mentors by function, request mentorship, end live mentorships
- Matching logic based on:
  - Location
  - Function
  - Mentor availability
- Email workflows:
  - Mentee request email to mentor with app link
  - Mentor accept/decline email back to mentee with optional message
  - Ended mentorship notifications
  - BCC logging email on all system emails (when configured)
  - Email audit log lines visible to admins in Relationship History
- Forgot password and reset password flow
- Account settings for all users to change email and password
- Personal profile fields for all users: Title, First name, Surname, Job title

## Tech Stack

- Node.js + Express
- EJS templates
- SQLite (`better-sqlite3`)
- Session auth (`express-session`)
- Password hashing (`bcryptjs`)
- Email (`nodemailer`)

## Local Run

1. Install dependencies:

```bash
npm install
```

2. Create local environment file:

```bash
cp .env.example .env
```

3. Start development server:

```bash
npm run dev
```

4. Open:

- http://localhost:3000

## Default Admin Credentials

- Login: `admin`
- Password: `admin`

You can update email/password from Account settings after login.

## Notes on Email

- SMTP settings are managed in the Admin dashboard.
- If SMTP is not configured, emails are captured via Nodemailer JSON transport and logged locally.

## Deploy on TrueNAS SCALE (Recommended)

This app can run well on TrueNAS SCALE using Docker/Compose with persistent volumes.

### 1) Prepare datasets

Create a dataset for the app with subfolders:

- `data` (SQLite database)
- `uploads` (logo uploads)

### 2) Configure environment

Copy env template and edit values:

```bash
cp .env.example .env
```

Recommended production values:

- `SESSION_SECRET` to a long random string
- `BASE_URL` to your public URL (for email links)
- `TRUST_PROXY=1` when behind reverse proxy
- `SESSION_COOKIE_SECURE=true` when serving over HTTPS

### 3) Build and run

```bash
docker compose up -d --build
```

The provided `docker-compose.yml` mounts:

- `./data -> /app/data`
- `./uploads -> /app/src/public/uploads`

### 4) Reverse proxy and TLS

Put Nginx/Caddy/Traefik in front of this app and route HTTPS traffic to container port `3000`.

### 5) TrueNAS app setup (UI path)

If using TrueNAS UI custom app:

- Use prebuilt image `ghcr.io/wntltd/tjx-manatee:latest`
- Set container port `3000`
- Map persistent host paths to `/app/data` and `/app/src/public/uploads`
- Add env vars manually in the App UI (see section below)

### 5a) Make it appear in Installed Applications

If you deployed with `docker compose` in shell, it runs but will not appear in TrueNAS Apps.

To have it listed in TrueNAS Apps:

1. Stop shell-managed container:

```bash
cd /mnt/<POOL>/manatee/app
sudo docker compose down
```

2. In TrueNAS UI: `Apps` -> `Discover Apps` -> `Custom App`.
3. Set app name: `manatee`.
4. Set image repository: `ghcr.io/wntltd/tjx-manatee`.
5. Set image tag: `latest`.
6. Add port mapping: host `3000` -> container `3000` (or use your preferred host port).
7. Add host-path volumes:
  - `/mnt/<POOL>/manatee/data` -> `/app/data`
  - `/mnt/<POOL>/manatee/uploads` -> `/app/src/public/uploads`
8. Add environment variables:
  - `NODE_ENV=production`
  - `PORT=3000`
  - `SESSION_SECRET=<long-random-secret>`
  - `BASE_URL=http://<TRUENAS_IP>:3000` (or HTTPS URL when proxied)
  - `TRUST_PROXY=0` for direct HTTP, `1` behind reverse proxy
  - `SESSION_COOKIE_SECURE=false` for direct HTTP, `true` on HTTPS
  - `SESSION_COOKIE_SAMESITE=lax`
9. Deploy app. It will now appear in `Installed Applications`.

Note: if GHCR package visibility is private, configure image pull credentials in TrueNAS. For easiest setup, set package visibility to public.

### 5b) Automatic image publishing (GitHub)

This repo includes workflow [`.github/workflows/publish-image.yml`](.github/workflows/publish-image.yml).

- On push to `master`, it publishes `ghcr.io/<owner>/tjx-manatee:latest`.
- On tag pushes (for example `v1.0.0`), it also publishes tag-based images.

### 6) Operations

- Upgrade: `docker compose pull && docker compose up -d`
- Logs: `docker compose logs -f manatee`
- Backup: snapshot/backup the `data` and `uploads` datasets

## TrueNAS Cutover Runbook (Local -> NAS)

Use this sequence to migrate safely and only remove local dev after validation.

### A) Create migration package on local machine

From project root:

```bash
./scripts/export-for-truenas.sh
```

This creates:

- `backups/truenas-export-<timestamp>.tar.gz`
- `backups/truenas-export-<timestamp>.tar.gz.sha256`

### B) Prepare TrueNAS datasets

In TrueNAS SCALE UI:

1. Create parent dataset, for example `apps/manatee`.
2. Under it, create:
  - `apps/manatee/data`
  - `apps/manatee/uploads`

### C) Copy and restore export onto TrueNAS host

Copy archive to NAS (SCP/SFTP), then on NAS shell:

```bash
mkdir -p /mnt/<POOL>/apps/manatee/migration
cp truenas-export-<timestamp>.tar.gz /mnt/<POOL>/apps/manatee/migration/
```

Extract and restore using script (if project files are available on NAS), or manually copy folders from extracted archive:

```bash
tar -xzf /mnt/<POOL>/apps/manatee/migration/truenas-export-<timestamp>.tar.gz -C /mnt/<POOL>/apps/manatee/migration
```

From extracted export, copy:

- `data/*` -> `/mnt/<POOL>/apps/manatee/data/`
- `uploads/*` -> `/mnt/<POOL>/apps/manatee/uploads/`

### D) Deploy app in TrueNAS SCALE

Use either custom app compose or app catalog path. Required mappings:

- Host path `/mnt/<POOL>/apps/manatee/data` -> container `/app/data`
- Host path `/mnt/<POOL>/apps/manatee/uploads` -> container `/app/src/public/uploads`

Set environment variables:

- `NODE_ENV=production`
- `PORT=3000`
- `SESSION_SECRET=<strong random string>`
- `BASE_URL=https://<your-domain-or-ip>`
- `TRUST_PROXY=1` (if behind reverse proxy)
- `SESSION_COOKIE_SECURE=true` (if HTTPS)
- `SESSION_COOKIE_SAMESITE=lax`

### E) Validate before local shutdown

1. Open app URL on TrueNAS and log in as admin.
2. Confirm users, requests, relationships, and history are present.
3. Upload a logo on Theme page to verify uploads persistence.
4. Restart app once from TrueNAS and verify data still present.

Only after all checks pass should you stop local dev.

### F) Enable FTP access for uploads/data

In TrueNAS SCALE:

1. Create a dedicated user (example: `manateeftp`).
2. Grant permissions on:
  - `/mnt/<POOL>/apps/manatee/uploads`
  - optionally `/mnt/<POOL>/apps/manatee/data` (only if you want DB file access)
3. Go to Services -> FTP, enable and configure:
  - Root/default path to `/mnt/<POOL>/apps/manatee`
  - Passive port range (for example `30000-30100`)
  - TLS enabled if external access is required
4. Open required firewall/NAT ports.

Security note: avoid exposing database path over FTP unless strictly required.

### G) Remove local dev environment (after successful cutover)

Recommended order:

1. Keep GitHub backup and local bundle backup.
2. Stop any local Node process.
3. Archive local project folder.
4. Remove local working copy only after a final NAS restart+retest.
