# NimbusStack security overview

*Company-wide document, updated 2026-01-15*

This document summarizes identity and access across the NimbusStack product line for security questionnaires.

## Identity

| Product | Federated sign-in |
|---|---|
| Nimbus Relay | SAML 2.0 on Enterprise |
| Nimbus Vault | SAML 2.0 on Enterprise |
| Nimbus Pulse | OpenID Connect on Pro and Enterprise |
| Nimbus Ledger | SAML 2.0 on every tier |

## Data handling

All products encrypt data at rest with AES-256 and in transit with TLS 1.2 or later. Audit log retention is set per product and per tier; see each product's pricing table where listed.
