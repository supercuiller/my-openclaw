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

```bash
openclaw config set "agents.defaults.models.google/gemini-flash-latest.rateLimits.requestsPerMinute" 800
openclaw config set "agents.defaults.models.google/gemini-flash-latest.rateLimits.inputTokensPerMinute" 1600000
openclaw config set "agents.defaults.models.google/gemini-flash-latest.rateLimits.outputTokensPerMinute" 1600000
```
