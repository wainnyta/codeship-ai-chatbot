# Nimbus Vault release notes

## 3.2 (2026-07-01)

**New**

- Dynamic database credentials for PostgreSQL and MySQL: Vault issues a credential that expires after the lease.
- SAML group mapping: identity provider groups map to Vault teams.

## 3.1 (2026-04-14)

**New**

- Salesforce integration generally available.
- HSM-backed keys on Enterprise.
- SAML 2.0 federated sign-in extended to the Pro tier (previously Enterprise only).

**Fixed**

- Secret version history showed the wrong author after a team rename.
