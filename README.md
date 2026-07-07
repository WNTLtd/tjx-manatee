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

- Use repository folder as build context (or prebuilt image)
- Set container port `3000`
- Map persistent host paths to `/app/data` and `/app/src/public/uploads`
- Provide env vars from `.env`

### 6) Operations

- Upgrade: `docker compose pull && docker compose up -d`
- Logs: `docker compose logs -f manatee`
- Backup: snapshot/backup the `data` and `uploads` datasets
