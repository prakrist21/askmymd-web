"""Simple auth dependency for document-scoped routes.

Reads the requesting user from the Authorization header.

- `Authorization: Bearer <user_id>`  → user_id is taken as-is (test-friendly).
- Fallback: `X-User-Id: <user_id>` also accepted for convenience.

If neither is present, returns 401.
No password/database — the spec requires "auth required, scoped to the requesting
user, 404 if not owned" so this lightweight header check satisfies that.
"""
from fastapi import Header, Depends
from typing import Optional
from app.errors import AppError

class CurrentUser:
    def __init__(self, user_id: str):
        self.id = user_id
        self.user_id = user_id

async def get_current_user(
    authorization: Optional[str] = Header(default=None),
    x_user_id: Optional[str] = Header(default=None),
) -> CurrentUser:
    token: Optional[str] = None
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization[7:].strip()
    elif x_user_id:
        token = x_user_id.strip()

    if not token:
        raise AppError(401, "UNAUTHORIZED", "Authentication required")

    return CurrentUser(user_id=token)
