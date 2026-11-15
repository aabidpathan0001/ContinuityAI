# ContinuityAI — CodeFrontier Round 3

ContinuityAI is an evidence-backed, continuously updated project-memory system designed for software handover. The product turns scattered project sources into structured knowledge, preserves evidence, surfaces conflicts and gaps, and produces a role-aware continuity package.

## Round 3 improvements

1. **Real AI knowledge extraction** — server-side OpenAI-compatible structured JSON extraction with schema validation. If no `AI_API_KEY` is configured, the demo uses a clearly code-level deterministic fallback so the product remains usable locally.
2. **Source integrations** — connector-oriented ingestion with TXT/Markdown/CSV/JSON uploads and a real GitHub public API sync endpoint. Jira/Slack/Teams are deliberately not claimed as live integrations in this build.
3. **Living continuity** — refresh/re-analysis, conflict detection, verification, audit history and version-ready relational storage prevent the product from being a one-time document generator.

## Stack

Node.js, Express, PostgreSQL, vanilla HTML/CSS/JS, JWT, bcrypt, Zod, Multer, Helmet and rate limiting.

## Run locally

1. Install Node.js 20+ and PostgreSQL.
2. Create a database named `continuityai`.
3. Copy `.env.example` to `.env` and set `DATABASE_URL` and a strong `JWT_SECRET`.
4. For real AI extraction set `AI_API_KEY` and optionally `AI_BASE_URL`/`AI_MODEL`.
5. Run `npm install`.
6. Run `npm start`.
7. Open `http://localhost:3000`.

The server applies `migrations/001_init.sql` on startup and creates the demo user if it does not exist.

## Demo credentials

Email: `demo@continuityai.app`

Password: `Demo@123456`

The login screen also has **Try Demo Project**, which signs in and loads the synthetic project without requiring external accounts.

## API highlights

- `POST /api/auth/login`
- `POST /api/auth/demo`
- `GET /api/projects`
- `POST /api/projects`
- `POST /api/projects/:id/sources`
- `POST /api/projects/:id/analyze`
- `GET /api/projects/:id/knowledge`
- `GET /api/projects/:id/conflicts`
- `POST /api/conflicts/:id/resolve`
- `POST /api/knowledge/:id/verify`
- `POST /api/projects/:id/refresh`
- `GET /api/projects/:id/continuity-package`
- `POST /api/integrations/github/sync`
- `GET /health`

## Security

Passwords are bcrypt-hashed. Authentication uses signed JWTs. Project access is checked through `project_members`. Uploads have file type and size limits. API credentials remain server-side. Helmet, CORS and rate limiting are enabled. Errors returned to the browser are intentionally sanitized.

## Testing

Run `npm test`. The included tests cover evidence preservation in the extraction layer and health-score behavior.

## Deployment

Deploy the Node process and PostgreSQL database separately or on a platform that supports both. Set environment variables in the platform secret manager, run `npm install`, then `npm start`. Configure `CORS_ORIGIN` to the deployed origin and use HTTPS.

## Known limitations

- The GitHub connector currently imports public repository metadata/issues/commits rather than implementing OAuth account linking.
- Jira and Slack/Teams are connector-ready but not presented as live integrations.
- PDF ingestion is intentionally omitted from this round's supported upload set.
- The AI fallback is deterministic and should not be described as model extraction when `AI_API_KEY` is absent.
- Knowledge version records are schema-ready; the current MVP prioritizes safe conflict surfacing and auditability over a full historical diff UI.
