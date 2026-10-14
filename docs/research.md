# REA reconstruction notes

Inspected 2026-10-14 using the installed [morluto/rea](https://github.com/morluto/rea) MCP tools. This is an independently written, functional reconstruction of the PIN-and-nickname quiz experience, named QuizPop!, with a local backend.

## Evidence and boundaries

Downloaded the public HTML from https://kahoot.it/ and the directly referenced public player bundle https://assets-cdn.kahoot.it/controller/v2/assets/controller-Cy0y9iHQ.js into `/tmp/kahoot-rea-artifacts`. The HTML declares build `controller v1.4319.0-184c5b70156`.

Called `analyze_javascript_application` with `input_path: /tmp/kahoot-rea-artifacts`, `detail: summary`, and `analysis_timeout_ms: 120000`. REA parsed two relevant files, 6,057,505 text bytes and 789,344 AST nodes, with zero parse failures and 3,597 findings. Root artifact SHA-256: `d6f4a0a40dff721ade40bbf52c89c6c00a40266da0f8cb28ad6677f0bdce5836`.

- Parent application Evidence: `ev_77ee15a6171e75f557a8256f0444ba9e5b45f89e9227c4a05b145b64a850230c`.
- Summary Evidence: `ev_d7c1f5a571d6a77dd297e443b769ac49d36e5642f799a4c2834287a620fecce3` (preserved in [rea-summary.json](rea-summary.json)).
- Follow-up `inspect_analysis_view` module page Evidence: `ev_fba210ef425f4eb88141b6613e4b1407a183fb69c6a55f8376807dfaecb7b28a`; first eight of 1,959 module-view items, not an exhaustive module inspection.

REA's application inventory was complete for these downloaded files. Its semantic graph was **partial** and reached the 100,000-node ceiling, leaving 88,578 semantic unknowns. Other bundles, dynamically loaded resources, private host pages, and server code were not inspected. Static analysis does not establish runtime execution or complete application behavior. The complete parent evidence remains session-retained; the checked-in summary is not a complete portable evidence bundle.

## Findings and reconstruction decisions

| Question | Evidence / observation | Outcome |
| --- | --- | --- |
| How does entry work? | Direct bounded text inspection of the REA-inventoried player bundle found PIN-entry labels, a Join button label, `gamePinEntered`, and nickname login data. | Implement PIN entry followed by nickname. Static observation; no original-site interaction observed. |
| What game state exists? | Bounded text inspection found question-number, time-available/time-left, and podium-route identifiers. | Implement timed questions and final rankings. Specific state transitions are our design, not recovered server behavior. |
| What answer presentation is suggested? | Bundle text contains shape-related UI component names and colored SVG elements. | Four colored, symbol-labelled answer tiles. Exact visual parity is unverified. |
| What can be recovered of server logic? | No server code supplied; REA cannot infer a complete server from this partial frontend evidence. | Independent HTTP/SSE server, secret host/player tokens, and authoritative timers. Original server protocol and scoring remain unknown. |
| What is implemented beyond the player page? | Quiz editor, saved library, host controls and lobby were not observed in the downloaded target. | Original local features supporting a complete playable Compose app. |

Our scoring formula awards a correct answer `round(500 + 500 * remainingTime / questionDuration)` points, with zero for incorrect or missing answers. This is a local design choice. All-player completion or the deadline reveals answers. Host advances to the next question and final leaderboard.

No screenshot or screen recording was taken. No original Kahoot source, fonts, graphics, or branding is redistributed in the application. The browser app has no external runtime assets or service dependencies. The downloaded artifacts remain temporary research inputs, outside the repository.

## Validation

Backend integration tests cover a multi-player game, host authorization, hidden correct answers and scores until reveal, duplicate submissions, timed reveals, persisted quiz ownership, and SSE reconnects. Browser smoke testing uses a separate headless browser profile and DOM interaction, without screen capture. Docker Compose has a real HTTP health check. See the project README for running the tests.

Completed checks on 2026-10-14:

- Four backend integration tests passed, including stale question submissions and joins racing with game start.
- Headless Chromium passed quiz creation, hosting, two separate player tabs, answer feedback, scoring, final podium, host refresh, mobile-width overflow, and uncaught-exception checks. No pixel capture.
- `docker compose up --build -d --wait` built successfully on Node 24 Alpine and reported the service healthy. Direct HTTP `/api/health` on port 8095 returned `{"ok":true}`.
- Ports 8080 and 8091 were occupied by existing services; the default port is 8095.
