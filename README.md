# TUFCBOT — Railway Ready

This package is prepared for Railway hosting. It keeps the existing TUFCBOT features and moves runtime JSON state to a persistent data directory.

## Included

- Discord bot and slash commands
- Member Hub / management permissions
- Club Rep / Club Representative management access
- Announcement button and `/announcement`
- Approved announcement channels
- PIMD public tools
- POTD monitor
- Forum event monitor
- EC party timers with restart recovery
- Google Sheets integration
- Web dashboard
- Railway persistent-volume support

## 1. Upload to GitHub

Create a private GitHub repository and upload the contents of this folder. Do **not** upload your real `.env`, Discord token, or Google service-account JSON.

## 2. Create the Railway service

In Railway, create a project and deploy this GitHub repository as a service. The start command is already defined as:

```text
npm start
```

Railway will install the dependencies from `package-lock.json` and start `index.js`.

## 3. Add the Railway Volume

Attach a Volume to the TUFCBOT service with this mount path:

```text
/data
```

The bot automatically uses Railway's `RAILWAY_VOLUME_MOUNT_PATH` when it exists. You do not normally need to set `DATA_DIR` yourself.

The persistent volume stores:

- `ec_timers.json` — active EC timers
- `event_state.json` — forum event state/history
- `potd_state.json` — POTD/PPOTD state and history

A fresh volume is seeded from the included `data-seed/` files. Existing volume files are never overwritten.

## 4. Add Railway Variables

Required:

```text
DISCORD_TOKEN=your Discord bot token
GOOGLE_SERVICE_ACCOUNT_JSON=<complete Google service-account JSON>
DISCORD_CLIENT_SECRET=your Discord OAuth client secret
DISCORD_CLIENT_ID=1545247213800919111
DASHBOARD_GUILD_ID=1362609555900600503
```

Optional/local alternative:

```text
GOOGLE_SERVICE_ACCOUNT_KEY=path/to/service-account.json
```

For Railway, use `GOOGLE_SERVICE_ACCOUNT_JSON` instead of uploading the service-account file.

### Dashboard URL

After Railway generates a public domain, the bot automatically uses `https://<RAILWAY_PUBLIC_DOMAIN>` for the dashboard OAuth callback unless `DASHBOARD_URL` is explicitly set.

In your Discord Developer Portal, add this OAuth2 redirect URI:

```text
https://YOUR-RAILWAY-DOMAIN/auth/callback
```

Replace `YOUR-RAILWAY-DOMAIN` with the actual Railway domain.

The dashboard health endpoint is:

```text
/health
```

## 5. Generate a Railway domain

Because the dashboard is a web server, generate a public Railway domain for the service. Railway should detect the port automatically from `PORT`.

## 6. Security

Keep these private:

- `DISCORD_TOKEN`
- `DISCORD_CLIENT_SECRET`
- `GOOGLE_SERVICE_ACCOUNT_JSON`

If the Discord bot token or Google service-account credentials were ever shared publicly, rotate/revoke them before production deployment.

## 7. Monitoring

Railway's service logs are the main place to monitor TUFCBOT. The service can be restarted/redeployed without losing JSON state because the state is stored on the attached Volume.
