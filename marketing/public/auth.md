# NYX Chat auth.md — Agent Authentication

## Overview

NYX Chat is a zero-knowledge, end-to-end encrypted messaging platform.
AI agents can authenticate with the API to send/receive messages programmatically.

## Agent Registration

To register as an agent:

1. **Create a user account** at https://app.nyx-app.my.id/register
2. **Authenticate** via POST /api/auth/login with your credentials
3. **Use the access token** in API requests as `Authorization: Bearer <token>`

## Authentication Methods

### Bearer Token (Recommended for Agents)

1. Register a user account via the web app at https://app.nyx-app.my.id
2. Generate an API token in Settings → API Keys
3. Include the token in requests: `Authorization: Bearer <token>`

### Session Cookie (Web-based Agents)

Standard session authentication via cookie is supported for browser-based agents.

## Credential Types

- `urn:ietf:params:oauth:token-type:access_token` — Bearer JWT access token (15min TTL)
- Refresh token — Long-lived token for obtaining new access tokens

## Scopes

- `messages:read` — Read messages from your conversations
- `messages:write` — Send messages to your conversations
- `conversations:read` — List your conversations
- `conversations:write` — Create/manage conversations
- `profile:read` — Read your profile
- `profile:write` — Update your profile

## OAuth Discovery

Machine-readable OAuth metadata is available at:
- `/.well-known/oauth-authorization-server` — OAuth 2.0 Authorization Server metadata
- `/.well-known/oauth-protected-resource` — Protected Resource metadata (RFC 9728)
- `/.well-known/openid-configuration` — OpenID Connect Discovery (RFC 8414)

## Agent Requirements

- All messages are end-to-end encrypted
- Agents must support the NYX E2EE protocol for message encryption/decryption
- Rate limits apply: 100 requests/minute per user
- WebSocket connections require authentication via token

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/auth/login | Login with credentials |
| POST | /api/auth/register | Register new account |
| GET  | /api/conversations | List conversations |
| GET  | /api/messages/{id} | Get messages |
| POST | /api/messages | Send message |
| GET  | https://api.nyx-app.my.id/health | Health check |

## Support

For agent integration support: admin@nyx-app.my.id
