# Fredagsquizet

A self-hosted multiplayer quiz game inspired by the Kahoot PIN-and-nickname experience, packaged for Docker Compose. Hosts create quizzes, share a game PIN, run timed questions, and show results and a final leaderboard. Players join from their own browsers. The server uses Node.js with no third-party runtime dependencies.

## Run with Docker Compose

Requires Docker with the Compose plugin. Configure a unique username and password in a local `.env` file before starting:

```sh
cp .env.example .env
# Edit .env and set a long, unique HOST_PASSWORD
docker compose up --build -d
docker compose ps
```

Open `/host` on the server to reach the quiz library and editor; the browser will request the Basic Auth credentials. The root URL remains public for players to enter a PIN and compete. Quiz management APIs, image uploads, room creation, and host controls require those same credentials. Joining, answering, and viewing player results remain public.

The browser's Basic Auth prompt is convenient on a trusted LAN. HTTP does not encrypt Basic Auth credentials, so place the service behind HTTPS before using it on an untrusted network or the Internet.

Open **http://localhost:8093** on the server machine. For a shared game, the host and players should open **http://SERVER_LAN_IP:8093** on the same network; allow inbound TCP port 8093 through the server firewall if necessary. A phone's `localhost` refers to that phone, so use the server's LAN address on other devices.

1. Open the host area at `/host` and sign in with the configured Basic Auth credentials. Host the shared Feature test quiz to try the game, or create a quiz.
2. Host the quiz and share its six-digit PIN.
3. Players open the same site, scan the host’s join QR code or enter the PIN, and choose a nickname and emoji. On phones, **Scan a QR code** opens the camera or image picker; on computers, choose an image containing the QR code.
4. Start after players join, then advance through the results and questions.

The built-in Feature test quiz is available to every host and demonstrates question previews, default artwork, true/false, typed answers, map pins, polls, and scoring. The Curiosity quiz can be removed from each host's library independently.

The default binding is all network interfaces so players can join over LAN. Set `QUIZ_BIND=127.0.0.1` for access only from this computer. This app is intended for trusted local networks; use a TLS reverse proxy and appropriate access controls before any Internet deployment.

To use a different host port:

```sh
QUIZ_PORT=8090 docker compose up --build -d
```

View logs or stop the application:

```sh
docker compose logs -f fredagsquizet
docker compose down
```

## Storage and access

Saved quizzes persist in the `quiz-data` Docker volume at `/app/data/quizzes.json`. Stopping or rebuilding the container preserves this volume. `docker compose down -v` deletes saved quizzes.

All hosts who sign in with the configured Basic Auth credentials share one quiz library. Quizzes are stored in the Docker volume and remain available across browsers and browser storage resets. Each quiz can include a creator name, which appears on its library card. Any authenticated host can edit or remove a saved quiz.

Active rooms, player sessions, and game scores live in server memory and reset whenever the server restarts. Run one application instance against its own data volume. The Compose service runs as the unprivileged `node` user with a read-only root filesystem; only the data volume and temporary directory are writable.

## Run and test without Docker

Requires Node.js 24 or later. No dependency installation is needed.

```sh
HOST_USERNAME=fredagsquizet HOST_PASSWORD=choose-a-long-password npm test
HOST_USERNAME=fredagsquizet HOST_PASSWORD=choose-a-long-password npm start
```

Open http://localhost:3000 for players or http://localhost:3000/host for the protected host area. Set `PORT` to change the listening port and `DATA_DIR` to change the default `./data` storage directory. Health status is available at `GET /api/health`.

## Research and scope

The implementation uses static inspection of the public player bundle as a reference and REA tooling from [morluto/rea](https://github.com/morluto/rea). See [research notes](docs/research.md) for observations, tooling, and limitations.

This is an independent implementation with its own local server and quizzes. It does not connect to Kahoot's proprietary backend, accept Kahoot game PINs, import private quizzes, or implement every Kahoot feature. It is not affiliated with or endorsed by Kahoot. Kahoot is a trademark of its respective owner.

## Pictures, previews, and question types

In **Create quiz** or **Edit**, choose a question type for each question:

- **Multiple choice:** choose one correct answer from 2–4 choices.
- **True or false:** two fixed choices; select the correct one.
- **Type an answer:** enter up to 10 accepted answers, one per line. Players type their response. Matching ignores capitalization and extra whitespace, with Unicode normalization; punctuation still matters.
- **Pin on a map:** choose the target by clicking the map or entering coordinates. Players pan, zoom, place a pin, and lock it in. Great-circle distance determines the score: `round(1000 × max(0, 1 − distance / zero-point distance))`, with no speed bonus. Set the zero-point distance from 1–20,000 km (default 2,000 km). The target stays hidden until reveal; players then see both pins, their distance, and points. Only a full 1,000-point pin counts as correct in the final tally. Maps require internet access and WebGL. [OpenFreeMap](https://openfreemap.org/) serves the map data without an API key, using OpenStreetMap data with visible attribution. The app bundles Leaflet 1.9.4, MapLibre GL JS 5.6.2, and the MapLibre–Leaflet adapter 0.1.3. It does not request tiles from OpenStreetMap’s volunteer-run raster servers.
- **Poll:** players vote on one choice. Results show vote counts; this round awards no points and has no leaderboard. A quiz containing only polls has no final winner.

Enter an optional creator name near the quiz title to identify who made it; all authenticated hosts see that name on its library card. Use **Upload cover picture** near the title to add an image shown on that quiz's library card. Use **Upload picture** under a question heading to add an image for that question. Both accept PNG, JPEG, WebP, or GIF (maximum 50 MB; the editor accepts up to 30 megapixels). You can also paste a public image URL, load it, and crop it to a landscape, square, or wide frame. Add a description for accessibility. Pictures can be replaced or removed in the editor. Quiz edits save automatically as you work; incomplete drafts are kept in the same browser and sync to the server once the required fields are valid.

Every question starts in **preview** on both host and player screens, displaying only the heading and optional picture. The host clicks **Open answers** to show the choices or typed-answer field and start the full answer timer. Preview has no timer; it survives refreshing the host screen. Correct answers and accepted typed responses stay hidden until the reveal.

Existing quizzes work as multiple-choice questions without needing conversion. The included curiosity quiz demonstrates all four types.

Uploaded pictures live in `/app/data/media` in the same persistent Docker volume as quizzes. Include that directory when backing up. Removing a picture from a question does not immediately delete its file, since another quiz or active game may use it. Uploaded pictures are accessible to anyone with their image URL on this server; only upload material intended for your players.

## Picture URLs, cropping, and default artwork

Paste a public picture URL into the URL field for a quiz cover or question, then choose **Load and crop**. The crop tool previews landscape, square, and wide frames; adjust zoom and position before saving. URL imports must return PNG, JPEG, WebP, or GIF image data no larger than 50 MB. Private-network addresses and redirects are rejected. Players choose one of the available emojis after entering the game PIN; the chosen emoji appears beside their nickname in the lobby and scoreboards.

Questions without an uploaded or URL-imported picture automatically show original colourful quiz-themed artwork. Each question type has its own illustration, shown in the editor, preview, answering, and results. Removing a custom picture restores the default. No external image service is needed.

The application, Compose project, service, container, and image are named **Fredagsquizet** (`fredagsquizet`). Compose explicitly sets the project name, so it does not depend on the checkout directory. Saved quizzes use the `fredagsquizet_quiz-data` Docker volume, and the network is `fredagsquizet_default`. Browser ownership, drafts, and sessions automatically migrate to `fredagsquizet-` storage keys. Existing installations with an older Compose project name must copy their quiz-data volume before starting the renamed project.

Basic Auth settings are read from `HOST_USERNAME` and `HOST_PASSWORD`. Change them in `.env` and recreate the container to rotate credentials. The local `.env` file is ignored by Git; keep it private.

Run `npm run test:map-browser` for the DOM-only map editor and two-player gameplay test (requires Chromium). No screen captures are taken.

The app retains its `no-referrer` policy. Allow `tiles.openfreemap.org` through any network filter for map styles, tiles, fonts, and sprites. Map initialization or download failures show a message while coordinate entry remains available. `npm run test:map-browser` uses a fixture map style for gameplay checks. `LIVE_MAP=1 npm run test:map-browser` instead checks a single live map, verifies successful vector-tile responses and rendered geographic features, and asserts that no OpenStreetMap raster tiles are requested. Neither test takes screenshots.

For existing servers, follow [Rename an existing deployment without losing quizzes](docs/rename-deployment.md). Reusing the existing volume as an explicitly named external volume is the simplest migration option.

Live rooms poll the current server state every 1.5 seconds, even when the event stream is connected. Stream events trigger a fresh state request instead of replaying their payload, and revision numbers prevent delayed responses from replacing newer questions. Returning to a tab or reconnecting the network triggers an immediate refresh. Run `npm run test:sync-browser` for the DOM-only regression test covering buffered streams and out-of-order responses.
