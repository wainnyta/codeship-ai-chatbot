# Nimbus Vault

*Product documentation, updated 2026-07-03*

Nimbus Vault stores secrets, credentials and certificates, and issues short-lived credentials to applications.

## Features

- Encrypted secret storage with versioning
- Dynamic database credentials (since 3.2)
- HSM-backed keys (Enterprise, since 3.1)
- Access policies per team and per application

## Pricing

Prices are per seat per month on an annual plan.

|  | Starter | Pro | Enterprise |
|---|---|---|---|
| Price | $12 | $35 | Custom |
| Secrets | 500 | 10,000 | Unlimited |
| Single sign-on | Password only | SAML 2.0 | SAML 2.0 |
| HSM-backed keys | No | No | Yes |
| Audit log retention | 30 days | 180 days | 400 days |
| Support plan | Community | Standard | Premium |

## Integrations

| Integration | Minimum Vault version | Partner requirement |
|---|---|---|
| Salesforce | 3.1 | Salesforce API v58 or later; a Connected App with the `api` scope |
| AWS Secrets Manager sync | 3.0 | IAM role with `secretsmanager:PutSecretValue` |
| GitHub Actions | 2.8 | OIDC trust to the repository |

## Support SLA

Response time to first human reply.

| Priority | Starter | Pro | Enterprise |
|---|---|---|---|
| P1 (service down) | 4 business hours | 1 hour | 30 minutes, 24x7 |
| P2 (degraded) | Next business day | 4 hours | 2 hours |
| P3 (question) | 3 business days | 1 business day | 8 hours |
| P4 (feature request) | Best effort | Best effort | 5 business days |
