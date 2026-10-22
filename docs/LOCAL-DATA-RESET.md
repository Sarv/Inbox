# Local data cleanup and reset

Updating or reinstalling Sarv Inbox keeps its local data and saved sign-ins.
Removing the application bundle does not remove the separate user profile.

## Erase a profile from Settings

Open **Settings → Advanced → Erase all local data**. Select **Sarv Inbox
(production)** or **Sarv Inbox Dev (development)**. The current profile is
selected initially; the full path is shown before any confirmation.

Choose **Erase all local data…**, type exactly `ERASE production` or
`ERASE development`, and confirm again in the native system dialog. Cancel is
the default in the system dialog. Refresh profile status after closing another
Inbox instance if that profile is reported as running.

Erasure removes the entire selected profile, including mail databases and
backups, downloaded attachments, saved account credentials and tokens, local
drafts and Outbox messages, assistant conversations, contacts, local calendar
events, settings, extensions data, logs, and browser storage inside that profile.
Local-only information cannot be recovered through Inbox after this action.

- Resetting the current production profile quits Inbox, erases the profile in
  a fresh process before opening storage, then starts onboarding.
- Resetting the current development profile quits the development app, erases
  its profile in a fresh reset-only process, and shows a completion message.
  Restart the development server manually afterward.
- Resetting the other profile requires that app to be closed. The current app
  stays open and its own data is preserved.

Mail on your email servers, the other profile, external-browser sign-in cookies,
files you saved outside the profile, and OS Keychain entries are preserved.
The Keychain encryption master alone cannot restore account tokens that were
removed with the profile. This local reset does not revoke provider access on
other devices or delete the remote account.

## Command-line cleanup

Run these commands from the repository. Quit the selected Inbox app first.
The script checks for running processes and refuses deletion if it cannot
establish that the selected profile is closed. It never kills an app for you.

```sh
# Preview a production reset without changing files or locks.
pnpm clean:db --profile production --full --dry-run

# Completely erase only the production profile.
pnpm clean:db --profile production --full

# Completely erase only the development profile.
pnpm clean:db --profile development --full

# Explicitly erase both current profiles. Both must be closed.
pnpm clean:db --profile all --full

# Default: development cache/log cleanup; keep all databases and sign-ins.
pnpm clean:db

# Cache/log cleanup of the installed production profile.
pnpm clean:db --profile production
```

`-y` and `--yes` never imply a full reset. Without `--full`, cleanup removes
only regenerable engine caches and application logs. It preserves mail
databases, drafts, Outbox, account credentials, attachment stores, calendar,
chats, browser sessions, settings, and extension data. This corrects the older
cleanup behavior that deleted mailbox databases containing local-only drafts.

Production and development use independent profiles under the OS app-data
directory. The CLI defaults to development and never selects production
implicitly. `all` means the two current profiles; older directories named
`Sarv Inbox AI` or `@sarvinbox/desktop` are not silently included.

## Reset implementation

CLI and Settings share the same profile removal implementation. Callers select
fixed profile IDs rather than supplying filesystem paths. An external operation
lock prevents a new Inbox startup from opening a profile during erasure. Path
validation refuses reset through symlinked profiles or ancestors; ordinary
startup and reinstall continue to support existing relocated profiles.

Current-profile resets require a native-confirmed, authenticated, short-lived
one-use ticket passed to the replacement process. Erasure happens before
logging, crash reporting, databases, Keychain access, browser sessions, or sync
start. Old email-link/calendar-file launch arguments are not replayed. Failed
or partial deletion stops startup and reports that the reset is incomplete.

Deletion tests use disposable temporary profiles and mocked confirmation APIs;
they do not erase the developer's real production or development profile.
