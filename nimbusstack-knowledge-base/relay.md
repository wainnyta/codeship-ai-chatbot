# Nimbus Relay

*Product documentation, updated 2026-06-12*

Nimbus Relay is a managed API gateway and event router. It sits in front of your services, enforces rate limits and authentication, and routes webhooks and events to downstream systems.

## Features

- Route-level authentication with per-route token scopes (since 4.0)
- Rate limiting with standard `X-RateLimit-*` response headers (since 4.1)
- Event routing and webhook delivery with automatic retry
- Request replay for debugging (Enterprise)
- Regional routing: US and EU endpoints (Enterprise)

## Pricing

Prices are per seat per month on an annual plan.

|  | Starter | Pro | Enterprise |
|---|---|---|---|
| Price | $19 | $49 | Custom |
| Included seats | 5 | 25 | Unlimited |
| API rate limit | 1,000 req/min | 10,000 req/min | 100,000 req/min |
| Single sign-on | No | No | SAML 2.0 |
| Audit log retention | 30 days | 90 days | 400 days |
| Request replay | No | No | Yes |
| Regional routing | US only | US only | US and EU |
| Support plan | Community | Standard | Premium |

## Integrations

| Integration | Minimum Relay version | Partner requirement |
|---|---|---|
| Slack | 4.1 | Slack app manifest v2 |
| Datadog | 4.0 | Datadog Agent 7.40 or later |
| Okta (SAML 2.0) | 4.0, Enterprise only | Okta Workforce Identity |
| Salesforce | Not supported | A community Zapier bridge exists; NimbusStack does not support it. |

## Support SLA

Response time to first human reply.

| Priority | Starter | Pro | Enterprise |
|---|---|---|---|
| P1 (service down) | 8 business hours | 2 hours | 15 minutes, 24x7 |
| P2 (degraded) | Next business day | 8 hours | 1 hour |
| P3 (question) | 3 business days | 2 business days | 8 hours |
| P4 (feature request) | Best effort | Best effort | 5 business days |

## Troubleshooting

**403 Forbidden on an API call.** Check, in this order:

1. The token's scope includes the route being called. Scopes are per route since Relay 4.0; a token minted for `/orders` cannot call `/customers`.
2. The caller's IP is on the workspace allowlist, if one is configured.
3. The seat that owns the token is not suspended.

**429 Too Many Requests.** The rate limit for the tier was reached. Read `X-RateLimit-Reset` for the retry time.
