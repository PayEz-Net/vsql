# VibeSQL as a remote database with a key (vsql key mode)

**For a partner who wants to reach their own VibeSQL data from a script, a test app or a service using a KeelBase client id and secret, with no person signed in.**

Status: draft, 2026-10-06. Written by Nextpert-Scout from measurements and reads made this week. Nothing here has been run against production.

## How to read this page

Every statement carries one of two tags:

- **[measured]**: somebody ran it, and the line says who, where and on which build. "dev-93" is the development server. Its Vibe API build is `6885dcae7`, which is older than master: it does not have the raw-SQL platform-admin gate (PAY-1844).
- **[read]**: taken from source code. Nobody ran it. Treat it as a prediction.

Anything not tagged is a definition, not a claim. The last section lists what is still open.

## 1. Install

```bash
npm install -g https://github.com/PayEz-Net/vsql/releases/download/v1.3.3/vsql-1.3.3.tgz
vsql version        # prints v1.3.3
```

- The URL answers 200 and installs; `vsql version` printed `v1.3.3` [measured: Nextpert-Scout, scratch prefix, 2026-10-06]. The release file's SHA-256 starts `8f759d83` and ends `1675`.
- `npm install -g vsql` installs a different, unrelated package named `vsql` (a 2017 "Vector SQL" package with no repository and no executable) [measured: npm registry metadata, read-only, Nextpert-Scout]. Always install from the URL above.
- Node.js 18 or newer [read: README].

## 2. The three variables

```bash
export VSQL_IDP_URL=https://idp.payez.net   # or IDP_URL: the identity service
export VIBE_CLIENT_ID=vibe_xxxxxxxxxxxxxxxx # your KeelBase client id: "vibe_" + 16 hex characters
export VIBE_HMAC_KEY=...                    # your KeelBase secret (base64), shown once
```

- With both `VIBE_CLIENT_ID` and `VIBE_HMAC_KEY` set, vsql is in **key mode**. With only one set it stops with an error and does not fall back to a sign-in [read: vsql `config.js`; README].
- The secret is read from the environment only: not from an argument, not written to `~/.vsql/config.json`, not printed [read: README, `config.js`].
- Every call is `POST {VSQL_IDP_URL}/api/vibe/proxy` with a body of `{endpoint, method, data}` and three headers: `X-Vibe-Client-Id`, `X-Vibe-Timestamp`, `X-Vibe-Signature` [measured: Nextpert-Scout, `VSQL_DEBUG=1`, dev-93, vsql 1.3.0 and 1.3.3].
- The signature is `base64( HMAC-SHA256( base64decode(secret), "{unix seconds}|{METHOD}|{endpoint}" ) )`. It covers the timestamp, the method and the endpoint as sent. **It does not cover the request body.** The server accepts a timestamp up to 5 minutes old and 1 minute ahead [read: vsql `signing.js`; Core `VibeClientAuthMiddleware.cs`, `VibeProxyController.cs`]. Widening it is tracked as PAY-2057.
- `--host` does not apply in key mode; vsql refuses it (`HOST_WITH_KEY`) [read: vsql `config.js`].

## 3. What works in key mode and what needs a sign-in

Walked on dev-93 with vsql 1.3.3 as a healed MvpOnly test client, against the only table that client had, `vibe_app.site_secrets` [measured: Nextpert-Scout, 2026-10-06, build `6885dcae7`]. I have not walked other tables or collections.

| Command | Result in key mode | Sent to the API |
|---|---|---|
| `health` | works | `GET /health` |
| `collections` | works | `GET /v1/collections` |
| `schemas` | works | `GET /v1/schemas` |
| `tables`, `tables <collection>` | works; an unknown collection is refused locally (`COLLECTION_NOT_FOUND`) | `GET /v1/schemas` |
| `schema show <collection>` | works | `GET /v1/schemas/<collection>/versions` |
| `rollback <collection> --list` | works | `GET /v1/schemas/<collection>/versions` |
| `rows <collection> <table>` | works | `GET .../tables/<table>?page=1&pageSize=20` |
| `insert` | works | `POST .../tables/<table>` |
| `update <id> --data '{...}'` | works (PATCH); non-object JSON is refused locally (`INVALID_JSON`) | `PATCH .../<table>/<id>` |
| `replace <id> --data '{...}'` | works (PUT) | `PUT .../<table>/<id>` |
| `delete <id> --yes` | works; without `--yes` in a script it is refused locally (`CONFIRMATION_REQUIRED`); a second delete says `NOT_FOUND` | `DELETE .../<table>/<id>` |
| `query "SELECT ..."` | **refused locally** (`NOT_WITH_KEELBASE_SECRET`), nothing sent | none |
| `describe <table>` | **fails in 1.3.3**: not refused locally, sends raw SQL, answers 403 `FORBIDDEN` on dev-93 | `POST /v1/vsql/query` |
| `schema update`, `rollback` (no `--list`) | refused locally (`NOT_WITH_KEELBASE_SECRET`) [measured on 1.3.0; for 1.3.3 read in source: `refuseDdlWithKey`] | none |

Notes:

- `query` is refused by the client, not by the server. There is no flag, variable or profile that makes vsql send it in key mode [read: vsql 1.3.3 source, Nextpert-Scout]. Do not call it a server rule.
- Raw SQL (`POST /v1/vsql/query`) is refused for everyone except a platform administrator or a configured first-party client on builds that have the PAY-1844 gate (`RAW_SQL_PLATFORM_ADMIN_ONLY`) [read: Core `VibeSqlController.cs`]. dev-93 does not have that gate: the 403 seen there reads `FORBIDDEN` and comes from the blocked-pattern guard, a different check. The raw-SQL route is also not tenant-safe today on production, which has row-level security on 0 tables [read: PAY-2058]. A key-mode client should not expect to run SQL.
- **Sign-in mode** (`vsql login`) is what `query` and schema changes use. I have not walked it: it needs a plain member user on dev-93 that does not exist yet. Read from the README: `vsql login` prints a code, and the approval screen does not exist yet, so the signed-in user approves the code with `POST {VSQL_IDP_URL}/api/ExternalAuth/agent-device/approve` using their own token; `vsql login --passwordless you@example.com` sends a 6-digit code by email instead. What `query` returns to a plain tenant user is **not measured**.

### `describe` until 1.3.4

- In the released 1.3.3, `describe` does not work in key mode (above).
- Use `vsql schema show <collection>`: it returns each table's `properties` (type, format, `x-vibe-pk`, `x-vibe-auto-increment`, description) and `required` list [measured: Nextpert-Scout, dev-93, 1.3.3].
- `describe` was moved onto the schema route (`GET /v1/schemas`) in vsql PR 10, which is merged to `main` with `package.json` at 1.3.4. **No 1.3.4 release exists**; the install URL above is still 1.3.3. To use the fix now you have to build from source (see the README). I read that change's code and ran its tests and mutants (71 tests) but have not run it against a live server [measured: tests, Nextpert-Scout, PR 10 gate].

## 4. The enterprise routes

All 15 enterprise routes are in one Core controller, `EnterpriseSchemaController`, under `/v1/enterprise/schemas`: list schemas, schema hash, show a schema, list versions, TypeScript types, create or update a schema, delete a schema, lock, unlock, add a table, drop a table, alter columns, create an index, analyze a change, migrate [read: QAPert, PAY-2058 comment, Core `b0e3922e01`]. They act on your own client id [read].

What is measured, and it is one route only [measured: DotNetPert, dev-93, build `6885dcae7`, key-signed through the proxy, GET only, mail 69431; the controller and the enterprise authorisation attribute are unchanged on master]:

| Licence on your credential | `GET /v1/enterprise/schemas` | `GET /v1/schemas/vibe_app` (control) |
|---|---|---|
| MvpOnly | 403 `ENTERPRISE_LICENSE_REQUIRED` | 200 |
| Enterprise | 200 | 200 |

So an Enterprise client reaches the enterprise routes through the proxy **with the same key and no new credential**: the proxy adds the client secret itself [measured result; mechanism read: PAY-2058]. **vsql 1.3.3 has no command that calls these routes.** Reach them by signing a call yourself as described in section 2, with `endpoint` set to the path, for example `/v1/enterprise/schemas`.

Not measured: the other 14 routes (including the ones that create, delete, lock or alter a schema), and whether each acts only on your own tenant on every route.

Two limits on any call through the proxy [read: PAY-2058, Core `VibeProxyController.cs`, unchanged between dev-93's build and master]:

- A path with `:`, `@`, `//`, `%2e`, `%2f`, `%5c`, `%40`, or a `.` or `..` segment is refused with 400 `ENDPOINT_INVALID`.
- A collection or table name that needs percent-encoding signs differently at the two ends and fails with 401 `SIGNATURE_MISMATCH` [measured as a side finding by QAPert-NightHawk, PAY-2059, dev-93; the cause is read]. Keep names to letters, digits and underscores.

## 5. The `site_secrets` table: the platform's row is off limits

Your `vibe_app.site_secrets` table holds a row whose `secret_name` is **`vibe_client_secret`**. It belongs to the platform, not to you. The identity service reads it on every call you make through the proxy [measured: DotNetPert, dev-93, log line on proxy calls; read: PAY-2058].

**Do not create, edit, rename or delete that row, and do not create a second row with that name.** Your own secrets in the same table, under other names, are yours.

What happened when it was touched, measured on dev-93 with a key-signed MvpOnly client (PAY-2053, build `6885dcae7`):

- A second row with the same name was accepted (201). Overwriting the platform row was accepted (200). Deleting it was accepted (204).
- After deleting the duplicate as well, every proxy call answered 400 `NO_VIBE_SECRET`, and the table's own rows route answered 400 too: the client is locked out until a platform administrator re-creates the credentials with the heal call (`POST /api/ClientAdmin/clients/{N}/vibe-credentials`). A partner cannot run that call.

Today nothing in the API stops you from doing this. A server-side refusal and a uniqueness rule are specified and released for merge (PAY-2053) but are not on Core master as of 2026-10-06 (`4f31f177c`), so they are not deployed [read]. Until they are, keeping to this rule is up to you.

Enterprise only [read: PAY-2058]: the enterprise routes check the secret in `site_secrets` against a stored hash. If the two do not match, the enterprise routes answer 401 `INVALID_CREDENTIALS` and the other routes keep working.

## 6. What a licence change takes to apply

- The licence is a property of your client credential. It is changed by a platform administrator in the client admin update, in one place only [read: PAY-2058, `ClientAdminController` line 2097]. You do not receive a new key, and vsql needs no change (measured above: the same key moved from 403 to 200).
- It does not apply at once. Vibe API caches it for about 5 minutes: after the change to Enterprise the enterprise route took **5 minutes 19 seconds** to answer 200, and after changing back it took **4 minutes 39 seconds** to answer 403 [measured: DotNetPert, dev-93, one change each way, PAY-2058]. A downgrade or a revoke is therefore not immediate either. Plan for a window of up to 5 minutes or a little more in both directions.
- Measured on dev-93 only. Production not measured.

## Not measured (so you do not assume it)

- Sign-in mode against a plain tenant user: `vsql login`, the approval step, `--passwordless`, and what `query` returns.
- Any key-mode command on a table or collection other than `vibe_app.site_secrets`.
- 14 of the 15 enterprise routes.
- Anything on production. dev-93's Vibe API build is `6885dcae7`: it lacks the raw-SQL gate and has older versions of `VibeClientAuthMiddleware`, `SchemasController` and the secrets service than Core master, so a result there is not a statement about production. `VibeProxyController`, `CollectionsController`, `TablesController`, `EnterpriseSchemaController` and the enterprise authorisation attribute are unchanged between that build and master `4f31f177c` (`git diff`, Nextpert-Scout).
- Whether the first-use write on `GET /v1/schemas` (it creates `vibe_app` and starter documents for a tenant that has none) can fire in sign-in mode. It did not fire in key mode on a healed client [measured: Nextpert-Scout, dev-93].
