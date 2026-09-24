# Sender reputation service — client contract

The desktop client's spam filter has two stages. The first judges a message
from its own headers, offline (`packages/core/src/utils/spam-signals.ts`). The
second asks about the *sender*: is the connecting IP on a blocklist, is the
domain, has anyone else reported it. Those lookups need the network and, for
the good lists, a licence — so they are meant to run on a Sarv-hosted service
that every client talks to with the user's own Sarv OAuth token. One place
holds the Spamhaus DQS key and the other feeds; sender IPs and domains go to
Sarv, not to list operators from each user's machine; and the service can add
the one signal no client can compute alone: how many other users flagged this
sender.

This document is the contract the client already implements
(`SarvReputationProvider` in `packages/core/src/utils/spam-reputation.ts`).
The service lives in its own repository.

On the client it is one of the two providers behind the ONE blocklist setting
(Security > Blocklists: "Sarv reputation service", with its address and the
report opt-in); the other is this computer's own DNSBL queries. Whichever is
chosen is asked about each new sender AS MAIL ARRIVES — before the message is
filed — and, when the user opted into link lookups, about the domains a body
links to once it is downloaded.

## Authentication

Every request carries `Authorization: Bearer <access token>` where the token
is the user's Sarv OAuth access token (the same one IMAP XOAUTH2 uses). The
service validates it against `oauth.sarv.com` and rate-limits per user.
A missing or rejected token (`401`/`403`) must make the client fail OPEN: the
message is judged from its headers alone.

## `POST /v1/reputation/lookup`

Request (`application/json`):

```json
{
  "ips": ["209.85.220.41", "2a00:1450:4864:20::32a"],
  "domains": ["brand.example", "reply.example"]
}
```

- `ips` — connecting-client addresses as the receiving server recorded them
  (`emails.origin_ip`). Public unicast only; the client never sends private
  ranges.
- `domains` — the registrable From and Reply-To domains of a message, or the
  domains a body links to, lower case. A sender lookup is one IP and a domain
  or two, asked as the message arrives; a link lookup is up to a few hundred
  domains per downloaded batch of bodies. The client deduplicates, and asks
  only for what its cache does not already hold.

Response (`200`, `application/json`):

```json
{
  "ips": [
    { "ip": "209.85.220.41", "status": "clean", "listed": [] },
    { "ip": "45.33.1.2", "status": "listed",
      "listed": [ { "list": "Spamhaus ZEN", "category": "spam", "detail": "SBL: spam source" } ] }
  ],
  "domains": [
    { "domain": "brand.example", "status": "clean", "listed": [], "userReports": 0 },
    { "domain": "reply.example", "status": "listed",
      "listed": [ { "list": "Spamhaus DBL", "category": "phishing", "detail": "phishing domain" } ],
      "userReports": 12 }
  ]
}
```

- `status` — `listed`, `clean`, or `unknown` (the service could not answer for
  this item; the client treats it as no signal, never as clean).
- `listed[].category` — one of `spam`, `exploited`, `phishing`, `malware`,
  `botnet`, `policy`, `abused`, `grey`, `unknown`. The client maps categories
  to points (`CATEGORY_POINTS` in spam-reputation.ts); the service does not
  send a score, so weights stay tunable client-side and identical for both
  providers.
- `listed[].detail` — one human-readable sentence, shown on the shield.
- `userReports` — how many distinct users reported mail from this domain as
  spam in the trailing window. Counted only from `POST /v1/reputation/report`
  with consent; the client applies it from `USER_REPORTS_MIN` (3) upwards.

Items missing from the response are treated as `unknown`.

Errors: any non-2xx, a timeout (the client allows 5 s — the answer is awaited
on the ingest path), or a body that is not JSON of this shape → the client
records nothing for those items and asks again the next time they appear.
After five failures in a row it stops asking for thirty minutes, so a service
that is down is not waited on by every message behind it; not being signed in
costs no request and does not count.

## `POST /v1/reputation/report` (later)

```json
{ "domain": "spammer.example", "ip": "45.33.1.2", "verdict": "spam" }
```

Sent when the user presses Report spam (or Not spam, `verdict: "ham"`), only
if the user has opted in. This is what feeds `userReports`. The client does
not send subjects, bodies or recipients — ever.

## Caching

The client caches per item in its core DB (`reputation_cache`): six hours for
a `listed` or `clean` answer. An `unknown` is never cached — it is asked about
again next time. The cache is shared with the local DNSBL provider's answers
and is emptied whenever the user changes who is asked. The service should
set `Cache-Control: max-age` if it wants to shorten that; the client honours
a smaller value, never a larger one.
