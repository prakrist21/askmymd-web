# AskMyMD

**Security notice:** Authentication is header-based (`Authorization: Bearer <user_id>`) with **no signature or expiry**. Any value in that header is accepted as the user ID. This is intended for **demo / personal use only** — do not use it to handle real user data or production traffic. See [SECURITY.md](./SECURITY.md) for details.

AskMyMD is a markdown editor with live preview and document-grounded chat. Paste or upload markdown, see it rendered, then ask questions about that document; answers are grounded in the document's content via retrieval-augmented generation.

## Stack

- **Frontend:** React + Vite, Tailwind CSS, marked + DOMPurify, Mermaid
- **Backend:** FastAPI, SQLAlchemy + pgvector, psycopg
- **LLM:** Groq (`openai/gpt-oss-120b` via `langchain-groq`)
- **Embeddings:** `sentence-transformers` `all-MiniLM-L6-v2` (384-dim, pgvector cosine)

## Quick start

```bash
# backend
pip install -r requirements.txt        # or pip install -r backend/requirements.txt
cp .env.example .env                   # fill in DATABASE_URL and GROQ_API_KEY
# pgvector: once per database
psql $DATABASE_URL -c "CREATE EXTENSION IF NOT EXISTS vector;"
uvicorn app.main:app --reload --app-dir backend

# frontend
cd frontend && npm ci
npm run dev   # http://localhost:5173
```

Environment variables are listed in `.env.example` (root) and `backend/.env.example` — both contain `DATABASE_URL` and `GROQ_API_KEY`. See [SECURITY.md](./SECURITY.md) — the Groq key stays server-side and is never sent to the frontend.

## Auth

All `/documents/*` routes require `Authorization: Bearer <user_id>` (or `X-User-Id: <user_id>`). The backend treats the header value as the authenticated user ID with no further verification — see the notice above.

## Project structure

```
frontend/src/
  components/Editor.tsx, Preview.tsx, ChatPanel.tsx
  api.ts, storage.ts
backend/app/
  main.py, auth.py, database.py, db.py, db_models.py
  routers/documents.py, routers/health.py
  services/rag_service.py, services/llm_service.py
```

## Security

See [SECURITY.md](./SECURITY.md).
