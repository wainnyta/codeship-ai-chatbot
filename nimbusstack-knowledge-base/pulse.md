# Nimbus Pulse

*Product documentation, updated 2026-08-22*

Nimbus Pulse is product analytics: events, funnels, retention and session replay.

## Features

- Event tracking with a JavaScript and a server SDK
- Funnels v2 (since 4.3)
- Session replay (beta since 4.1)
- Warehouse export

## Pricing

Prices are per workspace per month on an annual plan.

|  | Growth | Pro | Enterprise |
|---|---|---|---|
| Price | $99 | $299 | Custom |
| Monthly events | 5 million | 50 million | Custom |
| Session replay | No | Yes | Yes |
| Warehouse export | No | Snowflake | Snowflake, BigQuery |
| Support plan | Community | Standard | Premium |

## Access and sign-in

Single sign-on is available on Pro and Enterprise through OpenID Connect (OIDC), tested with Okta, Google Workspace and Microsoft Entra. SAML 2.0 is on the roadmap and is not available today.

## Integrations

| Integration | Minimum Pulse version | Partner requirement |
|---|---|---|
| Salesforce | 4.3 | Salesforce API v59 or later; read-only sync of Accounts and Opportunities |
| Segment | Any | Segment source key |
| Snowflake | 4.1 | A Snowflake role with `CREATE TABLE` on the target schema |

## Support SLA

Response time to first human reply.

| Priority | Growth | Pro | Enterprise |
|---|---|---|---|
| P1 (service down) | Next business day | 4 hours | 1 hour, 24x7 |
| P2 (degraded) | 2 business days | 1 business day | 4 hours |
| P3 (question) | 5 business days | 2 business days | 1 business day |
| P4 (feature request) | Best effort | Best effort | Best effort |

## Troubleshooting

**403 Forbidden on an API call.** Check, in this order:

1. The user who owns the API key is a member of the workspace the project belongs to.
2. The API key is bound to the project being queried; keys are per project since 4.0.
