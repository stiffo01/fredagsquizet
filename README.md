# Fredagsquizet

A self-hosted multiplayer quiz game inspired by the Kahoot PIN-and-nickname experience, packaged for Docker Compose. Hosts create quizzes, share a game PIN, run timed questions, and show results and a final leaderboard. Players join from their own browsers. The server uses Node.js with no third-party runtime dependencies.

## Run with Docker Compose

Requires Docker with the Compose plugin.

```sh
docker compose up --build -d
docker compose ps
```

Open **http://localhost:8095** on the server machine. For a shared game, the host and players should open **http://SERVER_LAN_IP:8095** on the same network; allow inbound TCP port 8095 through the server firewall if necessary. A phone's `localhost` refers to that phone, so use the server's LAN address on other devices.

1. Open the host area and choose the included quiz or create a quiz.
2. Host the quiz and share its six-digit PIN.
3. Players open the same site, enter the PIN, and choose a nickname.
4. Start after players join, then advance through the results and questions.

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

Quiz ownership uses a secret capability stored in the browser's localStorage. Use the same browser profile and site address to return to your saved library. Clearing browser storage loses access to its saved quizzes; changing the hostname or port creates a separate browser storage origin. This is a lightweight local quiz library without account recovery or shared user accounts. Keep browser storage private.

Active rooms, player sessions, and game scores live in server memory and reset whenever the server restarts. Run one application instance against its own data volume. The Compose service runs as the unprivileged `node` user with a read-only root filesystem; only the data volume and temporary directory are writable.

## Run and test without Docker

Requires Node.js 24 or later. No dependency installation is needed.

```sh
npm test
npm run test:browser # optional; requires system Chromium (or CHROMIUM=/path/to/browser)
npm start
```

Open http://localhost:3000. Set `PORT` to change the listening port and `DATA_DIR` to change the default `./data` storage directory. Health status is available at `GET /api/health`.

## Research and scope

The implementation uses static inspection of the public player bundle as a reference and REA tooling from [morluto/rea](https://github.com/morluto/rea). See [research notes](docs/research.md) for observations, tooling, and limitations.

This is an independent implementation with its own local server and quizzes. It does not connect to Kahoot's proprietary backend, accept Kahoot game PINs, import private quizzes, or implement every Kahoot feature. It is not affiliated with or endorsed by Kahoot. Kahoot is a trademark of its respective owner.

## Pictures, previews, and question types

In **Create quiz** or **Edit**, choose a question type for each question:

- **Multiple choice:** choose one correct answer from 2–4 choices.
- **True or false:** two fixed choices; select the correct one.
- **Type an answer:** enter up to 10 accepted answers, one per line. Players type their response. Matching ignores capitalization and extra whitespace, with Unicode normalization; punctuation still matters.
- **Poll:** players vote on one choice. Results show vote counts; this round awards no points and has no leaderboard. A quiz containing only polls has no final winner.

Use **Upload picture** under the question heading to add a PNG, JPEG, WebP, or GIF (maximum 5 MB; the editor accepts up to 30 megapixels). Add a description for accessibility. Pictures can be replaced or removed in the editor and remain visible during answering and results.

Every question starts in **preview** on both host and player screens, displaying only the heading and optional picture. The host clicks **Open answers** to show the choices or typed-answer field and start the full answer timer. Preview has no timer; it survives refreshing the host screen. Correct answers and accepted typed responses stay hidden until the reveal.

Existing quizzes work as multiple-choice questions without needing conversion. The included curiosity quiz demonstrates all four types.

Uploaded pictures live in `/app/data/media` in the same persistent Docker volume as quizzes. Include that directory when backing up. Removing a picture from a question does not immediately delete its file, since another quiz or active game may use it. Uploaded pictures are accessible to anyone with their image URL on this server; only upload material intended for your players.

## Paste pictures and default artwork

Copy an image, click **Paste picture here** on the desired question, and press **Ctrl+V** (or **⌘V** on Mac). The app listens for pasted image files anywhere inside that question, including the paste button, heading, and answers; ordinary text paste works normally. Copy the image itself, not just its URL. Clipboard images use the same validation and persistent storage as file uploads, and the paste gesture works on local-network HTTP without requesting clipboard-read access.

Questions without an uploaded or pasted picture automatically show original colourful quiz-themed artwork. Each question type has its own illustration, shown in the editor, preview, answering, and results. Removing a custom picture restores the default. No external image service is needed.

The application and Compose service are named **Fredagsquizet** (`fredagsquizet` in Compose). Existing browser ownership/session keys and the `quiz-data` volume remain unchanged so the rename preserves saved quizzes.
