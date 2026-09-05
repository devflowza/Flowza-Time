# ADR-003: Device provider abstraction with four connectivity modes and app-side credential encryption

**Status:** Accepted · **Date:** 2026-09-05

## Problem
Vendors differ in *who initiates* the connection: vendor cloud APIs (pull), vendor webhooks, devices that
push directly to a server URL (ZKTeco ADMS/PUSH, eSSL/FingerTec derivatives, Hikvision ISUP), and
on-prem servers/LAN device APIs (Suprema BioStar 2, Hikvision ISAPI). The attendance engine must not
know any of this. Credentials must never be plaintext or visible to clients.

## Options
- Connectivity: (a) vendor-cloud pull only; (b) mandatory LAN connector agent; (c) **provider adapter
  with declared integration mode(s), including a push-protocol handler hosted by the API**.
- Secrets: (i) plaintext columns; (ii) Supabase Vault; (iii) **application-side envelope encryption
  (AES-256-GCM, master key outside the database, key ids for rotation)**.

## Decision
(c) and (iii).

## Reasons
- Due diligence shows the GCC installed base is dominated by push-protocol and LAN devices; excluding
  them would exclude most customers. A connector agent is kept as a *future optional* mode, not a dependency.
- Providers expose declared capabilities, a config schema (drives the registration wizard), throttling
  limits and typed errors; the sync engine and UI adapt without vendor-specific code (§11–§12).
- Vault decrypts inside the database; anyone with DB access to the decrypted view can read secrets.
  App-side encryption keeps the key out of the database, allows rotation by key id, and still lets us store
  ciphertext in Postgres under RLS with no client policies.

## Trade-offs
- Push-protocol endpoints are internet-facing and must be hardened (device auth by serial + token, rate
  limiting, strict parsing, quarantine of unknown serials).
- Master key management becomes an operational responsibility (env/KMS). Documented in `docs/security.md`.
