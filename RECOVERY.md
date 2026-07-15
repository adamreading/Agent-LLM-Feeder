# Reboot recovery — feeder's role

Full docs: **`~/.hermes/RECOVERY.md`** (authoritative).

The feeder **server** (`server/`, `node dist/index.js`, OpenAI-compatible router on
:3001) has no supervisor, so a reboot leaves it down. The recovery system starts it
from `~/recover-stack.sh`:

- Gated on **Postgres readiness** (`pg_isready`) — feeder does NOT retry the DB on
  boot; if PG isn't up when it launches, `initDb` throws and it exits.
- Readiness/health probe = `GET :3001/api/requests?limit=1` (**not** `/api/health`,
  which can 200 on a broken DB / stale build).

Note: `~/ringer/engines/opencode-feeder.sh` is Ringer's OpenCode *client* wrapper,
not this server — supervising it does nothing for feeder availability.

An optional standalone `feeder.service` (Restart=on-failure, for mid-session crash
recovery too) is sketched in the full docs if per-service supervision is ever preferred
over the master script.
