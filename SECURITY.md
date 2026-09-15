# Security Policy

## Authentication Model

**This project uses header-based authentication with no cryptographic verification.**

- The backend accepts `Authorization: Bearer <user_id>` (or fallback `X-User-Id: <user_id>`) as defined in `backend/app/auth.py:21`.
- The `user_id` value is taken as-is — there is **no signature, no expiry, no token validation, and no password check**.
- Any client that knows or guesses a `user_id` can impersonate that user and access their documents.

This is intentional for **demo and personal use only**. It satisfies the spec requirement "auth required, scoped to the requesting user, 404 if not owned" for local development and testing without the complexity of JWT/OAuth.

## Intended Use

- **Intended for:** demo, local development, personal single-user deployments.
- **NOT intended for:** handling real user data, multi-tenant production traffic, or any environment where data confidentiality matters.

Do not deploy this authentication model to production with sensitive data. If you fork for production use, replace `backend/app/auth.py` with proper authentication (e.g., signed JWT with expiry, OAuth2, or session cookies) and add authorization tests before handling real user data.

## Reporting a Vulnerability

If you discover a security vulnerability, please open an issue or contact the maintainers directly. Do not include sensitive data in public issues. For the demo auth limitation itself, this is a known design decision — see above.
