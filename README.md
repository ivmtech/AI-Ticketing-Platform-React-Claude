This is a [Next.js](https://nextjs.org) project bootstrapped with `[create-next-app](https://nextjs.org/docs/app/api-reference/cli/create-next-app)`.

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses `[next/font](https://nextjs.org/docs/app/building-your-application/optimizing/fonts)` to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Run unattended as a Windows Service (NSSM)

The app boots the WhatsApp client automatically on server start (see
`instrumentation.ts`), and the headless Chrome it drives lives in your Windows
user session. If you simply **log out**, that session is torn down and you'll see
`Attempted to use detached Frame` errors. Running the app as a Windows Service
keeps it alive regardless of login state.

> **Why NSSM?** It auto-restarts the app on crash and captures stdout/stderr to
> log files — Task Scheduler does neither well.

### One-time setup

**0. Authenticate once (interactively).** A service can't display the QR code, so
scan it first. The session is saved to `.wwebjs_auth` and reused by the service.

```powershell
cd "C:\Users\IVM\Development\AI-Ticketing-Platform-React-Claude"
npm run build
npm start          # scan the QR, wait for "WhatsApp client ready", then Ctrl+C
```

**1. Install NSSM**, then close and reopen PowerShell so it's on your PATH:

```powershell
winget install nssm
```

**2. Open PowerShell as Administrator**, then create and configure the service
(replace `YOUR_PASSWORD` with the Windows password for the `alvin` account):

```powershell
$proj = "C:\Users\IVM\Development\AI-Ticketing-Platform-React-Claude"

nssm install WhatsAppMonitor "C:\Program Files\nodejs\node.exe"
nssm set WhatsAppMonitor AppDirectory  "$proj"
nssm set WhatsAppMonitor AppParameters "node_modules\next\dist\bin\next start"
nssm set WhatsAppMonitor AppStdout     "$proj\service-out.log"
nssm set WhatsAppMonitor AppStderr     "$proj\service-err.log"
nssm set WhatsAppMonitor Start         SERVICE_AUTO_START
nssm set WhatsAppMonitor ObjectName    ".\alvin" "YOUR_PASSWORD"
```

> The service **must** run under the same account that did the QR scan (so Chrome
> and `.wwebjs_auth` match). If the account has no password, the `ObjectName`
> line won't work — use the LocalSystem fallback instead.

**3. Start it and verify** — look for `WhatsApp client ready` in the log:

```powershell
nssm start WhatsAppMonitor
Start-Sleep 25
Get-Content "$proj\service-out.log" -Tail 30
```

The dashboard is then reachable at [http://localhost:3000](http://localhost:3000),
and you can log out without interrupting scans.

### Managing the service


| Command                               | Use                                                                      |
| ------------------------------------- | ------------------------------------------------------------------------ |
| `nssm restart WhatsAppMonitor`        | Stop then start — use after a rebuild or config change to load new code. |
| `nssm stop WhatsAppMonitor`           | Stop the app (no scans run). Use before maintenance.                     |
| `nssm status WhatsAppMonitor`         | Print state (`SERVICE_RUNNING` / `SERVICE_STOPPED`). Quick health check. |
| `nssm edit WhatsAppMonitor`           | Open the GUI to change paths, account/password, or env vars.             |
| `nssm remove WhatsAppMonitor confirm` | Uninstall the service entirely.                                          |


### After modifying the code

The service runs `next start`, which serves the **compiled production build** —
editing a source file changes nothing until you rebuild. After any code change:

```powershell
cd "C:\Users\IVM\Development\AI-Ticketing-Platform-React-Claude"
npm run build
nssm restart WhatsAppMonitor
```

Then verify the restart picked up your changes — look for `WhatsApp client ready`:

```powershell
Start-Sleep 25
Get-Content ".\service-out.log" -Tail 30   # look for "WhatsApp client ready"
```

- You do **not** normally need to re-scan the QR — the session in `.wwebjs_auth`
survives rebuilds and restarts. Re-scan only if WhatsApp itself logs you out.
- While actively developing, it's easier to `nssm stop WhatsAppMonitor` and run
`npm run dev` directly (live reload + visible console). Rebuild and
`nssm start` when you're done.

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.