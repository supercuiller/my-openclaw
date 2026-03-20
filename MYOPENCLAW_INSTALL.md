# OpenClaw Fresh Debian VM Setup

## 1. Install Node.js 22+ and pnpm

```bash
# Node 22 via NodeSource
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# pnpm
npm install -g pnpm
```

## 2. Install system dependencies

```bash
sudo apt-get install -y libnspr4 libnss3 libnss3-dev libdbus-1-3 libatk1.0-0 \
  libatk-bridge2.0-0 libxcomposite1 libxdamage1 libxrandr2 libgbm1 libxkbcommon0 \
  libpango-1.0-0 libcairo2 libasound2
```

## 3. Install repo dependencies and build

```bash
cd /path/to/your/openclaw-repo
pnpm install
pnpm build
```

> `pnpm build` is required — the gateway service runs from `dist/index.js`.

## 4. Install and start the gateway service

```bash
pnpm openclaw gateway install
pnpm openclaw gateway start
```

> Use `pnpm openclaw` (not a global `openclaw` binary) so the service unit points to your dev build.

## 6. Configure headless browser

```bash
openclaw config set browser.headless true
openclaw config set browser.noSandbox true
```

## 7. Set rate limits (Gemini Flash example)

Gemini Flash free tier limits: 1K RPM, 2M TPM (combined input+output), 10K RPD.
Applying 20% margin:

```bash
openclaw config set "agents.defaults.models.google/gemini-flash-latest.rateLimits.requestsPerMinute" 800
openclaw config set "agents.defaults.models.google/gemini-flash-latest.rateLimits.totalTokensPerMinute" 1600000
```

> Use `totalTokensPerMinute` (not separate input/output limits) — Gemini's 2M TPM cap is combined.

## 8. Update from git

After pulling new commits, rebuild and reinstall the gateway service:

```bash
cd /path/to/your/openclaw-repo
git pull --rebase
pnpm install
pnpm build
pnpm openclaw gateway install
pnpm openclaw gateway start
```

> `pnpm openclaw gateway install` updates the systemd unit to point at the new `dist/index.js`.
