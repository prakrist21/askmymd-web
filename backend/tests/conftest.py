"""Force all tests to use a dedicated test DB and start empty.

- Tests must NEVER touch dev data. Default: the local isolated DB
  `askmymd_test` on localhost (create once with `createdb askmymd_test`).
- Optional override: set `TEST_DATABASE_URL` (or `SUPABASE_TEST_DATABASE_URL`)
  to a separate hosted test project.

- Ensures vector extension + tables exist.
- TRUNCATEs documents/chunks/chat_messages BEFORE and AFTER each test.
"""

from __future__ import annotations

import os

# Force test DB before any app import that caches the engine.
# Priority: TEST_DATABASE_URL > SUPABASE_TEST_DATABASE_URL > local askmymd_test.
_test_url = os.getenv("TEST_DATABASE_URL") or os.getenv("SUPABASE_TEST_DATABASE_URL")
if _test_url:
    os.environ["DATABASE_URL"] = _test_url
else:
    # Local isolated test DB — works whether dev is local Postgres or hosted,
    # and tests never TRUNCATE dev data either way.
    os.environ["DATABASE_URL"] = "postgresql://postgres:1234@localhost:5432/askmymd_test"

import pytest
from sqlalchemy import text

from app.database import get_engine, Base
import app.db_models  # ensure tables registered


@pytest.fixture(autouse=True)
def db_isolation():
    engine = get_engine()
    assert engine is not None, "DATABASE_URL must be set (TEST_DATABASE_URL or fallback)"
    # Isolation guard: test DB must not be the dev Supabase DB.
    # For local fallback db is `askmymd_test`; for Supabase test project db is `postgres`
    # but on a different host (different project ref). Reject if host/db exactly equals dev.
    _dev_raw = os.getenv("DATABASE_URL", "")
    # Engine already points at test DB; verify we didn't accidentally pick dev Supabase.
    # Allow `askmymd_test@5432` (local) or `postgres@supabase` with different host.
    if engine.url.database == "askmymd_test":
        pass  # local fallback — always isolated from Supabase dev
    elif "supabase.co" in str(engine.url.host or ""):
        # Must be a *different* Supabase project than dev, or explicitly allowed test URL.
        # If TEST_DATABASE_URL wasn't set and dev is Supabase, we already fell back to local,
        # so reaching here means TEST_DATABASE_URL *was* set to a Supabase host — accept.
        assert _test_url is not None, "Supabase test DB requires TEST_DATABASE_URL to be set to a second project"
    else:
        # Generic: ensure DB name is askmymd_test when not Supabase
        assert engine.url.database == "askmymd_test", f"tests must run on isolated test DB, got {engine.url.database}@{engine.url.host}"

    # Ensure extension + tables exist (idempotent)
    with engine.begin() as conn:
        conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
    Base.metadata.create_all(engine, checkfirst=True)

    # Hard truncate BEFORE test — kills leftovers from a crashed prior run
    with engine.begin() as conn:
        conn.execute(text("TRUNCATE documents, chunks, chat_messages, images CASCADE"))

    yield

    # Truncate AFTER test — normal isolation
    with engine.begin() as conn:
        conn.execute(text("TRUNCATE documents, chunks, chat_messages, images CASCADE"))
