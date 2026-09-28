<!--
DRAFT: not legal advice. Have counsel review before publishing.
Publish at: https://sarv.com/inbox/privacy (must be on the domain verified for
the Google Cloud project, and linked from the app's homepage).
Every statement below describes what the code does at the time of writing.
If a behaviour changes, update this file in the same change. Google's reviewers
compare the policy against the app, and a mismatch fails verification.
Items marked [CONFIRM] need a business answer before publishing.
-->

# Sarv Inbox Privacy Policy

**Effective date:** [CONFIRM: publication date]

Sarv Inbox ("the app") is a desktop email client for macOS, Windows and Linux,
published by Sarv Webs Private Limited ("Sarv", "we", "us"), IT-10, EPIP RIICO
Industrial Area, Sitapura, Jaipur, Rajasthan 302022, India.

This policy explains what information the app handles, where it goes, and the
choices you have. The short version: **your mail is stored on your own computer,
encrypted. We do not run a server that stores or syncs your mail. We do not sell
your data, show you ads, or use your mail to train AI models.**

## 1. Information the app handles

When you connect an email account, the app downloads and stores on your device:

- your email messages, attachments, folders and labels;
- the names and addresses of people you correspond with (your contacts);
- your account settings and preferences.

To connect, you either sign in with your email provider (Google, Microsoft or
Sarv) using OAuth, or you enter an IMAP/SMTP password. The app receives access
and refresh tokens from your provider; it never sees your Google or Microsoft
password.

## 2. Where your data is stored

- **On your device.** Mail is kept in a local database encrypted with a random
  256-bit key. That key, your OAuth tokens and any passwords are protected by
  your operating system's secure storage (Keychain on macOS, DPAPI on Windows,
  Secret Service on Linux). On Linux systems with no Secret Service available,
  the key is stored unencrypted on disk, and the app tells you so.
- **With your email provider.** Your mail stays on your provider's servers as
  usual. Changes you make in the app (reading, moving, deleting, sending,
  drafts, labels) are made on the provider's servers.
- **Not with us.** Sarv does not receive, store or sync a copy of your mailbox
  or your settings, except for the features described in section 4 that you
  use.

## 3. Google user data

When you sign in with Google, the app requests these permissions:

| Permission | Why |
| --- | --- |
| `https://mail.google.com/` | To read, send, organise and delete your Gmail over IMAP and SMTP, the protocols the app uses. Gmail's IMAP/SMTP access accepts only this permission. |
| `openid`, `email`, `profile` | To show which Google account is connected. |

The app uses Gmail data **only to provide the email features you see in the
app**. Your Gmail data:

- is not sold;
- is not used for advertising, including personalised or retargeted ads;
- is not used to determine creditworthiness or for lending;
- is not used to develop, improve or train generalised or non-personalised AI or
  machine-learning models, by us or by anyone we share it with;
- is not read by any person at Sarv, except with your explicit consent for a
  specific message (for example, one you send us in a support request), when
  needed for security purposes such as investigating abuse, or to comply with
  the law.

Gmail data is transferred to third parties only as described in section 4, only
to provide features you use, and only to the extent needed for them.

**Sarv Inbox's use and transfer of information received from Google APIs to any
other app will adhere to the
[Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
including the Limited Use requirements.**

## 4. When data leaves your device

### 4.1 AI features

The app's AI features (sorting mail into categories, suggesting reply drafts,
extracting conversations, detecting signatures, filling in contact details, and
AI search) work by sending parts of your mail to the AI provider you choose. **No
mail is sent to any AI provider until you connect one.**

- **Which provider:** Sarv AI, or your own account with OpenAI, Google Gemini or
  another OpenAI-compatible service. Signing in with Sarv makes Sarv AI your AI
  provider. [CONFIRM: add a consent step at that point; see the note to
  maintainers.]
- **What is sent:** depending on the feature:
  - the sender, recipients, subject and date of a message, and part of its
    text (the first 1,000 characters, for sorting);
  - for reply drafts, the message and the rest of its conversation;
  - your search query, for AI search;
  - a contact's name, address and signature details, for contact details.
- **When:** sorting, conversation extraction, signature detection, contact
  details and reply drafts run automatically on new mail while AI is on. AI
  search runs when you search.
- **Sarv AI:** requests are processed by Sarv's AI gateway and the model
  provider behind it [CONFIRM: name the model host(s) and region]. Sarv does not
  keep prompts or responses after answering them [CONFIRM: retention], and does
  not use them to train models.
- **Your own provider:** requests go directly from your device to that provider
  under your own agreement with them. Their privacy policy applies.
- **Your choices:** turn AI off, or turn individual features off, in Settings →
  AI. Suggested drafts are saved to your mailbox's Drafts folder and are never
  sent without you.

If you enable **web research** for drafts, the search query goes to Tavily
(api.tavily.com) using your own Tavily key. It is off by default.

### 4.2 Crash and error reports

Official builds send crash and error reports to Sentry (Functional Software,
Inc.), which we use to find and fix bugs. A report can contain:

- the error and where it happened;
- your app version, operating system and language;
- your mail server's host name;
- a shortened one-way hash of your email address, to group reports from the
  same installation;
- a trail of recent app activity, such as connection and sync steps.

[CONFIRM: once addresses are removed from these reports, say so here. Until
then this sentence must stay:] That activity trail can include email addresses
of senders. Reports do not include message bodies or attachments. A native
crash can include a snapshot of app memory at the moment of the crash.

[CONFIRM: add "You can turn crash reports off in Settings → …" once that setting
exists.]

### 4.3 Spam and phishing protection

To judge whether a new message is spam, the app checks the sending server's IP
address and the sender's domain against public blocklists (Spamhaus, SpamCop,
Barracuda, URIBL and SURBL) using DNS lookups from your device. It also looks up
when the sender's domain was registered, using the public RDAP registry
service. These lookups include the IP address and domain, never the message.
They can be turned off in Settings → Security → Blocklists.

If you choose the optional **Sarv reputation service**, those IP addresses and
domains are sent to Sarv instead, with your Sarv sign-in. If you also turn on
**spam reports**, the domain and IP of messages you mark as spam or not spam are
shared with Sarv to improve protection for all users. Both are off by default.

### 4.4 Sender pictures and logos

To show a picture next to a contact, the app asks Gravatar (Automattic Inc.)
whether a picture exists for that address. It sends a one-way MD5 hash of the
email address, never the address itself. [CONFIRM: add a setting to turn this
off, then document it here.]

To show a company logo, the app looks up the sender domain's published brand
logo (BIMI) and website icon, directly from that domain. You can turn these
off in Settings.

### 4.5 Images in email

Images in a message are loaded from the sender's servers. That tells the sender
your IP address and that you opened the message. By default the app only loads
images automatically for senders and categories you are likely to trust; for
the rest it asks first. You can change this in Settings.

### 4.6 Updates, extensions and connectivity

- The app checks GitHub for new versions about once an hour. That request
  carries your IP address, app version and platform, but no personal data.
- The extension catalogue and extensions you install are downloaded from GitHub
  and jsDelivr. An extension can only make its own network requests if you
  grant it that permission.
- The app checks your internet connection by contacting `www.google.com`.

### 4.7 Sarv accounts

If you sign in with a Sarv account, Sarv processes your mailbox (for Sarv Mail),
the AI requests described above, and your account details under the
[Sarv privacy policy](https://sarv.com/privacy) [CONFIRM: URL].

## 5. What we do not do

- We do not sell or rent personal data.
- We do not show ads or use your data for advertising.
- We do not use analytics or tracking tools in the app.
- We do not use your mail, or anything derived from it, to train AI models.

## 6. Keeping and deleting your data

Your mail stays on your device for as long as the account is connected in the
app.

- **Remove an account:** Settings → Accounts removes it and deletes that
  account's local mail database. [CONFIRM: tokens are only deleted locally, and
  only for the currently selected account. Fix, then keep this text:] Its sign-in
  tokens are deleted from your device.
- **Revoke access:** you can revoke the app's access at any time, whether or not
  it is installed:
  - Google: <https://myaccount.google.com/permissions>
  - Microsoft: <https://account.live.com/consent/Manage>, or
    <https://myapps.microsoft.com> for work accounts
- **Uninstall:** uninstalling removes the app. To remove all local data, also
  delete the app's data folder:
  - `~/Library/Application Support/Sarv Inbox` on macOS
  - `%APPDATA%\Sarv Inbox` on Windows
  - `~/.config/Sarv Inbox` on Linux

We keep crash reports for up to 90 days [CONFIRM: your Sentry retention].

## 7. Security

Mail is encrypted at rest on your device. All connections to email providers,
AI providers and our services use TLS. Sign-in uses OAuth with PKCE, so no
password is stored for OAuth accounts. To report a security issue, email
support@sarv.com with the subject "[Sarv Inbox] Security".

## 8. Children

The app is not directed to children under 13 (or the minimum age in your
country), and we do not knowingly collect their data.

## 9. Your rights

Depending on where you live (for example under India's Digital Personal Data
Protection Act, the GDPR or US state laws), you may have the right to access,
correct or delete personal data we hold, or to object to its use. Most of your
data never reaches us; for the data that does (AI requests to Sarv AI, Sarv
reputation reports, crash reports), write to privacy@sarv.com [CONFIRM:
mailbox exists] and we will answer within 30 days.

## 10. Changes

We will post changes to this policy on this page and update the effective date.
Material changes will also be announced in the app's release notes.

## 11. Contact

Sarv Webs Private Limited, IT-10, EPIP RIICO Industrial Area, Sitapura, Jaipur,
Rajasthan 302022, India. Email: privacy@sarv.com. Grievance officer (India):
[CONFIRM: name, email].
