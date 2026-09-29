# CloudMosaic (local + Hostinger)

Marketing site is a **built React SPA** (static files under `static/`).  
`/time` is a **PHP + MySQL** time-tracking app.

Live site: https://cloudmosaic.ai  
GitHub: https://github.com/amitnverma/sumanthcloudmosaic

## Local development (XAMPP)

Your files already live at:

`/Applications/XAMPP/xamppfiles/htdocs/cloudmosaic`

### 1. Start Apache + MySQL

Open **XAMPP Manager** and start **Apache** and **MySQL**.

### 2. Create the time-tracking database

With MySQL running, open once:

http://localhost/cloudmosaic/time/setup.php

That creates the `timetracking` database, tables, and sample projects.

### 3. Open the site

| URL | What |
|-----|------|
| http://localhost/cloudmosaic/ | Marketing SPA |
| http://localhost/cloudmosaic/about | Example SPA route |
| http://localhost/cloudmosaic/time/ | Time tracking UI |
| http://localhost/cloudmosaic/time/hello.php | PHP health check |

Uses existing MySQL database **`timetracking`** (`root` / empty password via `time/config/db.local.php`).  
That file is **gitignored** so production passwords never get pushed.

Verified local flow: projects / settings / create-save-update-delete time entries against `timetracking`.

### Important: React source is not in this copy

What you copied from the VPS is the **production build** (`index.html` + hashed JS/CSS).  
There is no `package.json` / `src/` here.

- **Edit marketing pages deeply** → you need the original React project source, then `npm run build` and replace the static files.
- **Edit time tracking** → edit files under `time/` directly (PHP/JS/CSS); refresh the browser.
- **Small static tweaks** (favicon, images, meta in `index.html`) → edit those files in place.

## Git + auto-deploy (other sites stay untouched)

On every push to `main`, GitHub Actions runs `.github/workflows/deploy-hostinger.yml`, which rsyncs **only** into:

`/home/cloudmosaicaissh/htdocs/cloudmosaic.ai`

SSH user is locked to `cloudmosaicaissh`. Other VPS sites are never written.  
`time/config/db.local.php` on the server is **never overwritten**.

### One-time GitHub secrets

Repo → **Settings → Secrets and variables → Actions**:

| Secret | Value |
|--------|--------|
| `HOSTINGER_HOST` | SSH hostname or IP from hPanel → Advanced → SSH Access |
| `HOSTINGER_SSH_KEY` | Private key for `cloudmosaicaissh` (full `BEGIN…PRIVATE KEY` block) |
| `HOSTINGER_PORT` | Optional. Try `65002` (Hostinger SSH) or `22` (VPS). Workflow auto-tries both. |

Public key for the existing local deploy key (`~/.ssh/hostinger_timetracking.pub`):

```text
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPYzpimW94a2mB7pN/sjBR0j38iaD2Bt/o3cwkGcmSR4 github-deploy-timetracking
```

That line must be in `/home/cloudmosaicaissh/.ssh/authorized_keys` on the VPS.  
Then paste the matching **private** key (`~/.ssh/hostinger_timetracking`) as `HOSTINGER_SSH_KEY`.

After secrets are set, every push to `main` deploys automatically (or use **Actions → Deploy to Hostinger VPS → Run workflow**).

## Production notes (VPS)

- Site root: `/home/cloudmosaicaissh/htdocs/cloudmosaic.ai`
- Time app: `.../cloudmosaic.ai/time`
- Nginx PHP for `/time` only: see `time/scripts/nginx-time-php.snippet.conf` and `time/scripts/enable-php-for-time.sh`
- Deploy script: `scripts/deploy-hostinger.sh`
