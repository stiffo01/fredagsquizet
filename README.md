# QuizPop!

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
docker compose logs -f quiz
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
