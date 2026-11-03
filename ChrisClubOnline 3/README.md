# Chris Club

Chris Club keeps its original single-page Three.js game and adds an Express and Socket.IO service for online rooms. The server runs the same billiards solver and rules source embedded in the client. Players send shot parameters; the server validates the current turn and simulates the shot before publishing ball snapshots. Clients cannot submit ball positions or decide the result of a rack.

## Run locally

Requirements: Node.js 18 or newer and pnpm 9 or newer.

```sh
pnpm install
pnpm start
```

Open `http://localhost:3000`. Use **Online Multiplayer** to create a private room, join a room by code, or enter public matchmaking. Both players must ready up before the three second start countdown. Room tickets are stored in the browser so a player can reconnect after a temporary network drop.

`public/index.html` supports offline practice and local matches. Online rooms use the configured Socket.IO server. With the default empty `public/server-config.js`, the game connects to the same origin. For a static frontend, set `window.CHRIS_CLUB_SERVER_URL` to the backend's HTTPS origin. The client loads that server's Socket.IO browser library and connects directly. Set `ALLOWED_ORIGINS` on the backend; Render's server origin is detected from `RENDER_EXTERNAL_URL`. `.env.example` lists the supported values. `/health` provides a deployment health check.

## Deploy on Render

Create a new Render Web Service from this project. The included `render.yaml` uses the Node runtime, installs the locked dependencies, starts the Express server, and checks `/health`. For a Netlify frontend, set `ALLOWED_ORIGINS` to its exact origin (for example, `https://your-site.netlify.app`). Do not include a path or trailing slash.


## Netlify frontend and Render multiplayer server

1. Drop the Netlify frontend and copy its `netlify.app` URL. The local modes work before the backend is connected.
2. Deploy this project to Render. Set `ALLOWED_ORIGINS` to the exact Netlify origin during Blueprint setup (or in the Render Environment settings).
3. Copy the Render HTTPS URL into `server-config.js` as `window.CHRIS_CLUB_SERVER_URL`, then redeploy the Netlify frontend.

The backend must be running separately because Netlify Drop hosts the static frontend; Socket.IO rooms run on the Node service.

## Project map

- `public/index.html` — original single-file game with the online lobby and network client.
- `server.js` — Express routes, room lifecycle, validation, matchmaking, reconnection, and authoritative shot simulation.
- `shared/physics.mjs` — server-importable build of the exact solver and rules source embedded in the HTML.
- `scripts/sync-shared-physics.js` — regenerates the server module from the marked solver in `public/index.html`.
- `test/` — fixed-step physics and two-client multiplayer integration checks.

After editing the in-page physics or rules, run `pnpm physics:sync` before starting the server. Room names and profiles are local nicknames; the project does not claim to provide account authentication or persistent ranking records.

## Verify

```sh
pnpm test
```
