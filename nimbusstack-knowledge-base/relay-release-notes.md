# Nimbus Relay release notes

## 4.2 (2026-06-10)

**New**

- Request replay: replay any request from the last 7 days against a staging endpoint. Enterprise.
- Regional routing: an EU endpoint (`eu.relay.nimbusstack.com`) with data residency in Frankfurt. Enterprise.
- Pro tier pricing changes to $59 per seat per month for new contracts signed on or after 1 August 2026. Existing contracts keep their price until renewal.

**Fixed**

- Webhook retry storm when a downstream returned 5xx for more than ten minutes.

## 4.1 (2026-03-02)

**New**

- Slack integration generally available.
- `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset` headers on every response.

**Fixed**

- Audit log export dropped entries older than 60 days on Pro.
