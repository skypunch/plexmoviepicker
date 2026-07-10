# Plex Movie Picker

A tiny static web app that signs into your Plex account, reads your movie
library, and picks a random film for you — with a satisfying shuffle
animation. Pure HTML/CSS/JS: no build step, no frameworks, no backend, no
external dependencies.

## How it works

- **Sign-in** uses Plex's official PIN-based auth flow, entirely in the
  browser. You're redirected to plex.tv to approve the app, then sent back.
- **Server discovery** finds your Plex Media Server through plex.tv and talks
  to it over its secure `*.plex.direct` HTTPS address.
- **Random pick** uses `crypto.getRandomValues()` with rejection sampling, so
  every movie has an exactly equal chance (no modulo bias, no
  `Math.random()`).

## Requirements

- A Plex account with at least one owned Plex Media Server.
- **"Secure connections"** enabled on the server (Settings → Network →
  Secure connections: *Preferred* or *Required*). This is what provides the
  `*.plex.direct` HTTPS endpoint the app connects to.
- The server must be reachable from wherever you open the app (remote access
  enabled, or same network).

## Deploying to GitHub Pages

1. Create a new GitHub repository and push these files to it:

   ```sh
   git init
   git add index.html style.css app.js README.md
   git commit -m "Plex movie picker"
   git branch -M main
   git remote add origin https://github.com/<your-username>/<repo>.git
   git push -u origin main
   ```

2. In the repository on GitHub, go to **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to *Deploy from a branch*,
   choose the `main` branch and the `/ (root)` folder, and save.
4. After a minute or two your app is live at
   `https://<your-username>.github.io/<repo>/`.

GitHub Pages serves over HTTPS, which is required — Plex's secure endpoints
can't be called from an insecure page.

## Privacy & security note

After you sign in, the app stores your **Plex auth token in your browser's
`localStorage`, on your own device only**. It is sent exclusively to plex.tv
and to your own Plex server, never anywhere else — there is no backend, no
proxy, and no analytics. Use the **Sign out** link to remove the token from
the browser at any time. Avoid signing in on shared or public computers.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page structure |
| `style.css` | Dark, mobile-friendly styling |
| `app.js` | Auth flow, Plex API calls, random pick, UI logic |
