"""Postgres connection via SQLAlchemy 2.0 + psycopg (v3).

Reads ``DATABASE_URL`` from the environment (loaded via ``python-dotenv``).
No host/port/database is hardcoded — switching between local Postgres and a
hosted provider (Supabase/Neon) is a single env-var change.

``DATABASE_URL`` standard format:
    postgresql://user:pass@host:port/dbname
    postgresql+psycopg://user:pass@host:port/dbname  (also accepted)

The ``postgresql://`` scheme is normalized to ``postgresql+psycopg://`` so
SQLAlchemy uses the installed ``psycopg`` (v3) driver rather than looking
for ``psycopg2``. Both forms are accepted so a hosted-provider URL can be
pasted verbatim.

Setup prerequisite (once per database, before first table creation):
    CREATE EXTENSION IF NOT EXISTS vector;

Engine is created lazily and does not attempt a network connection at
import time — importing this module never requires a running database.
"""

from __future__ import annotations

import os
from typing import Generator

from dotenv import load_dotenv
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

load_dotenv()


class Base(DeclarativeBase):
    """Declarative base for all ORM models (documents, chunks, chat_messages)."""


def _normalize_url(url: str) -> str:
    """Map bare ``postgresql://`` to ``postgresql+psycopg://`` for psycopg v3.

    SQLAlchemy treats ``postgresql://`` as ``postgresql+psycopg2://`` by
    default, which would require ``psycopg2-binary``. We use ``psycopg``
    (v3, ``psycopg[binary]``) so the ``+psycopg`` dialect must be explicit.
    Already-qualified URLs (``postgresql+psycopg://``, ``postgresql+asyncpg://``,
    etc.) are left untouched.

    Supabase: if the host is ``*.supabase.co`` and no ``sslmode`` is present,
    append ``sslmode=require`` — Supabase (both direct and pooler) requires
    SSL with ``psycopg``. This keeps a verbatim copy-paste from the dashboard
    working even if the user forgets to add the query param.
    """
    if url.startswith("postgresql://"):
        url = url.replace("postgresql://", "postgresql+psycopg://", 1)
    # Auto-append sslmode=require for Supabase if missing
    if "supabase.co" in url and "sslmode" not in url:
        url += ("&" if "?" in url else "?") + "sslmode=require"
    return url


def get_database_url() -> str | None:
    """Return the raw ``DATABASE_URL`` value or ``None`` if not set/empty."""
    raw = os.getenv("DATABASE_URL")
    if raw is None:
        return None
    raw = raw.strip()
    return raw if raw else None


# Lazily-initialized singletons — no connection at import time.
_engine: Engine | None = None
_session_factory: sessionmaker[Session] | None = None


def get_engine() -> Engine | None:
    """Return the SQLAlchemy Engine, creating it on first call.

    Returns ``None`` when ``DATABASE_URL`` is not set so the app can still
    be imported and the v1 ``/prepare`` + ``/chat`` in-memory path keeps
    working without a database. Callers that require the DB should raise a
    clear error when this returns ``None``.
    """
    global _engine, _session_factory
    if _engine is not None:
        return _engine
    url = get_database_url()
    if url is None:
        return None
    normalized = _normalize_url(url)
    # Supabase Transaction pooler (6543 + pgbouncer=true) doesn't support
    # server-side prepared statements. psycopg/SQLAlchemy use them by
    # default, which breaks with `prepared statement "..." does not exist`.
    # Session pooler (5432) supports them normally. Only disable when
    # transaction mode is detected.
    connect_args = {}
    if "pgbouncer=true" in normalized:
        # psycopg3: prepare_threshold=None disables prepared statements
        connect_args["prepare_threshold"] = None
    _engine = create_engine(
        normalized,
        pool_pre_ping=True,
        connect_args=connect_args if connect_args else {},
    )
    _session_factory = sessionmaker(bind=_engine, autocommit=False, autoflush=False)
    return _engine


def get_session_factory() -> sessionmaker[Session] | None:
    """Return the sessionmaker bound to the current engine, or ``None``."""
    # Ensure engine is initialized first.
    if _session_factory is not None:
        return _session_factory
    if get_engine() is None:
        return None
    return _session_factory


def get_db() -> Generator[Session, None, None]:
    """FastAPI dependency that yields a DB session per request.

    Usage:
        @router.get("/x")
        def handler(db: Session = Depends(get_db)): ...

    Raises a 500-style error if ``DATABASE_URL`` is not configured.
    """
    factory = get_session_factory()
    if factory is None:
        raise RuntimeError(
            "DATABASE_URL is not set — configure it to use Postgres/pgvector. "
            "Example: postgresql://user:pass@host:port/dbname "
            "(and run CREATE EXTENSION IF NOT EXISTS vector; once per database)"
        )
    db = factory()
    try:
        yield db
    finally:
        db.close()


def ping_db() -> bool:
    """Return True if the database is reachable (SELECT 1 succeeds)."""
    engine = get_engine()
    if engine is None:
        return False
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        return True
    except Exception:
        return False


# Convenience alias so `from app.database import engine` still works for
# verification scripts that expect an ``engine`` attribute at import time.
# This does NOT connect — it is lazily created on first access via
# ``get_engine()``. Accessing ``engine`` when DATABASE_URL is unset gives None.
engine: Engine | None = get_engine()
