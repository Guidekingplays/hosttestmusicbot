# Discord Music Bot

Slash-command music bot that sits in **Do Not Disturb** status.

## Commands
`/play` `/skip` `/pause` `/resume` `/stop` `/queue` `/nowplaying` `/shuffle` `/volume` `/loop`

## Setup
1. Go to https://discord.com/developers/applications -> **New Application** -> **Bot** tab -> **Reset Token** and copy it.
   No privileged intents are needed.
2. Invite the bot: **OAuth2 -> URL Generator**, scopes `bot` + `applications.commands`,
   permissions: View Channels, Send Messages, Embed Links, Connect, Speak.
3. Install **yt-dlp** (https://github.com/yt-dlp/yt-dlp) and make sure `yt-dlp --version` works.
   Keep it updated (`yt-dlp -U`) - YouTube changes often.
4. Install Node.js 20+, then in this folder:
   ```
   npm install
   cp .env.example .env     # fill in DISCORD_TOKEN and GUILD_ID
   npm start
   ```

## Changing the status
In `index.js`, the `presence.status` is `PresenceUpdateStatus.DoNotDisturb`.
Other options: `Online`, `Idle`, `Invisible`.
