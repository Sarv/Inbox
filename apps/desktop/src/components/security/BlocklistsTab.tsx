import { BLOCKLISTS } from '@sarv-in/mailguard/reputation';
import { normalizeBlocklistEndpoint } from '@sarvinbox/core/blocklist-prefs';
import { CalendarClock, Cloud, Globe, Info, Link2, Server } from 'lucide-react';
import { useState } from 'react';

import { getReputationPrefs, setReputationPrefs } from '../../store/helpers';
import { Tooltip } from '../Tooltip';

/**
 * Blocklists — the spam checks that leave this machine, and the ONE place they
 * are set. (Until 2026-09-24 a second control in Settings > General asked the
 * same lists again in the background; its choices are migrated into this
 * section by core's `readBlocklistPrefs`.)
 *
 * Every other stage of the filter reads the message that already arrived. This
 * one asks somebody else — a list operator over DNS, or the Sarv service —
 * about the server that delivered it and the domains it claims to be from, and,
 * if the user allows, the domains it links to. That is a real disclosure: the
 * operator learns, in near real time, who writes to this user. So the tab says
 * so plainly. It starts ON with every list ticked — a week-old campaign is on
 * these lists long before it is anywhere else — and each list can be unticked
 * here.
 *
 * The resolver field is not a power-user detail. Spamhaus and its peers refuse
 * queries that arrive through a public or open resolver — an ISP's DNS, or
 * 8.8.8.8 — which is the normal setup on a home connection. Asking without a
 * resolver of one's own usually means those lists refuse, their breakers
 * retire them, and only the others answer. Saying so here is cheaper than
 * letting somebody discover it as a silence.
 *
 * The catalogue comes from `@sarv-in/mailguard/reputation`, a subpath
 * entry that reaches `node:dns` only through a dynamic import. Its one cost in
 * the browser is `ipaddr.js`, which is CommonJS — so it is named in
 * `LINKED_CJS_DEPS` (apps/desktop/vite/linked-packages.ts) to keep it in Vite's
 * pre-bundle. Without that the dev server serves it unconverted and this tab
 * takes the whole window down; see docs/mailguard.md.
 */
export function BlocklistsTab() {
  const [prefs, setPrefs] = useState(getReputationPrefs);
  const [serversDraft, setServersDraft] = useState(() => prefs.servers.join(', '));
  const [endpointDraft, setEndpointDraft] = useState(() => prefs.endpoint);

  const save = (next: typeof prefs) => {
    setPrefs(next);
    setReputationPrefs(next);
  };

  const toggleZone = (name: string) => {
    const zones = prefs.zones.includes(name)
      ? prefs.zones.filter((zone) => zone !== name)
      : [...prefs.zones, name];
    save({ ...prefs, zones });
  };

  const commitServers = () => {
    const servers = serversDraft
      .split(/[\s,]+/)
      .map((server) => server.trim())
      .filter(Boolean);
    setServersDraft(servers.join(', '));
    save({ ...prefs, servers });
  };

  // Stored normalised — https only, no trailing slash — but the draft keeps
  // what was typed, so a mistyped address is shown with its warning rather
  // than silently erased.
  const commitEndpoint = () => {
    const endpoint = normalizeBlocklistEndpoint(endpointDraft);
    if (endpoint) setEndpointDraft(endpoint);
    save({ ...prefs, endpoint });
  };
  const endpointRejected = endpointDraft.trim() !== '' && normalizeBlocklistEndpoint(endpointDraft) === '';

  const sarv = prefs.provider === 'sarv';

  return (
    <div className="p-6 max-w-4xl space-y-8">
      <section>
        <div className="rounded-lg border border-border bg-card p-4 flex items-start gap-3">
          <Info className="h-5 w-5 mt-0.5 text-primary flex-shrink-0" />
          <div className="text-sm text-muted-foreground space-y-2">
            <p className="text-foreground font-medium">
              Blocklists ask somebody else about your mail.
            </p>
            <p>
              Every other spam check reads the message itself. This one sends the delivering
              server&rsquo;s address, and the sender&rsquo;s domains, to whoever you choose below — a
              blocklist operator over DNS, or Sarv&rsquo;s reputation service — as each message
              arrives, so a listed sender is filed before you see it. That operator learns who
              writes to you, as it happens. Untick a list, or the switch, and it is not asked.
            </p>
            <p>
              A listing adds to a message&rsquo;s spam score. It is never the whole verdict on its
              own: a shared mail server appears on a list for reasons that have nothing to do with
              the person who wrote to you.
            </p>
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <label className="flex items-center gap-3 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={prefs.enabled}
            onChange={(event) => save({ ...prefs, enabled: event.target.checked })}
            className="h-4 w-4 accent-primary"
            aria-label="Ask blocklists about incoming mail"
          />
          <span className="font-medium">Ask blocklists about incoming mail</span>
        </label>
        <label className="flex items-start gap-3 text-sm cursor-pointer pl-7">
          <input
            type="checkbox"
            checked={prefs.links}
            disabled={!prefs.enabled}
            onChange={(event) => save({ ...prefs, links: event.target.checked })}
            className="h-4 w-4 mt-0.5 accent-primary"
            aria-label="Also ask about the domains a message links to"
          />
          <span>
            <span className="flex items-center gap-2 font-medium">
              <Link2 className="h-4 w-4 text-muted-foreground" />
              Also ask about the domains a message links to
            </span>
            <span className="block text-xs text-muted-foreground">
              Once a message&rsquo;s body is downloaded, every domain it links to is asked about
              too — the classic phish comes from anywhere and links to a listed site. The domains
              your mail links to are then sent as well.
            </span>
          </span>
        </label>
      </section>

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">
          Who is asked
        </h2>
        <div className="rounded-lg border border-border divide-y divide-border">
          <label className="flex items-start gap-3 px-3 py-3 text-sm cursor-pointer hover:bg-accent/40 transition-colors">
            <input
              type="radio"
              name="blocklist-provider"
              checked={!sarv}
              onChange={() => save({ ...prefs, provider: 'local' })}
              className="h-4 w-4 mt-0.5 accent-primary"
              aria-label="Ask the lists through this computer's DNS"
            />
            <Server className="h-4 w-4 mt-0.5 flex-shrink-0 text-muted-foreground" />
            <span className="flex-1">
              <span className="font-medium">This computer&rsquo;s DNS</span>
              <span className="block text-xs text-muted-foreground">
                Each list below is asked directly, from here.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-3 px-3 py-3 text-sm cursor-pointer hover:bg-accent/40 transition-colors">
            <input
              type="radio"
              name="blocklist-provider"
              checked={sarv}
              onChange={() => save({ ...prefs, provider: 'sarv' })}
              className="h-4 w-4 mt-0.5 accent-primary"
              aria-label="Ask the Sarv reputation service"
            />
            <Cloud className="h-4 w-4 mt-0.5 flex-shrink-0 text-muted-foreground" />
            <span className="flex-1">
              <span className="font-medium">Sarv reputation service</span>
              <span className="block text-xs text-muted-foreground">
                Sarv&rsquo;s service is asked with your Sarv sign-in, so lookups never go to list
                operators from your machine.
              </span>
            </span>
          </label>
        </div>
        {prefs.enabled && !sarv && prefs.zones.length === 0 && (
          <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
            No list is selected, so nothing will be asked.
          </p>
        )}
      </section>

      {sarv ? (
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">
            Sarv service
          </h2>
          <div className="rounded-lg border border-border bg-card p-4 space-y-3">
            <Tooltip content="The service's https address" delayMs={40}>
              <input
                type="url"
                value={endpointDraft}
                onChange={(event) => setEndpointDraft(event.target.value)}
                onBlur={commitEndpoint}
                placeholder="https://reputation.sarv.com"
                aria-label="Sarv reputation service address"
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </Tooltip>
            {endpointRejected ? (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                The address has to start with https:// — nothing is asked until it does.
              </p>
            ) : (
              !prefs.endpoint && (
                <p className="text-xs text-muted-foreground">Nothing is asked until the service address is set.</p>
              )
            )}
            <label className="flex items-start gap-3 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={prefs.reports}
                onChange={(event) => save({ ...prefs, reports: event.target.checked })}
                className="h-4 w-4 mt-0.5 accent-primary"
                aria-label="Share my Report spam and Not spam verdicts"
              />
              <span>
                Share my Report spam / Not spam verdicts so they count for other Sarv Inbox users
                <span className="block text-xs text-muted-foreground">
                  Only the sender&rsquo;s domain, its server address and your verdict are sent — never
                  the message.
                </span>
              </span>
            </label>
          </div>
        </section>
      ) : (
        <>
          <section>
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">
              Lists to query
            </h2>
            <div className="rounded-lg border border-border divide-y divide-border">
              {BLOCKLISTS.map((list) => {
                const on = prefs.zones.includes(list.name);
                return (
                  <label
                    key={list.name}
                    className="flex items-center gap-3 px-3 py-3 text-sm cursor-pointer hover:bg-accent/40 transition-colors"
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => toggleZone(list.name)}
                      className="h-4 w-4 accent-primary"
                      aria-label={`Query ${list.zone}`}
                    />
                    <Globe className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                    <span className="flex-1">
                      <span className="font-medium">{list.zone}</span>
                      <span className="ml-2 text-muted-foreground">
                        {list.kind === 'ip' ? 'sending servers' : 'sender and linked domains'}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Each operator sets its own terms of use. Check them before querying a list at volume.
            </p>
          </section>

          <section>
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">
              Resolvers
            </h2>
            <div className="rounded-lg border border-border bg-card p-4 space-y-3">
              <div className="flex items-start gap-3">
                <Server className="h-5 w-5 mt-0.5 text-primary flex-shrink-0" />
                <div className="text-sm text-muted-foreground">
                  The big operators refuse queries that reach them through a public or shared resolver
                  — which is what your ISP&rsquo;s DNS, and 8.8.8.8, are. Their refusal is not a
                  listing, and Sarv Inbox reads it as a refusal and stops asking that list for a
                  while, but it does mean that list scores nothing. Point this at a resolver of your
                  own to get answers.
                </div>
              </div>
              <Tooltip content="One or more resolver addresses, comma separated" delayMs={40}>
                <input
                  type="text"
                  value={serversDraft}
                  onChange={(event) => setServersDraft(event.target.value)}
                  onBlur={commitServers}
                  placeholder={"Leave empty to use this computer's own DNS settings"}
                  aria-label="Resolver addresses for blocklist queries"
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </Tooltip>
            </div>
          </section>
        </>
      )}

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">
          Registration dates
        </h2>
        <label className="rounded-lg border border-border bg-card p-4 flex items-start gap-3 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={prefs.domainAge}
            onChange={(event) => save({ ...prefs, domainAge: event.target.checked })}
            className="h-4 w-4 mt-0.5 accent-primary"
            aria-label="Check how recently sender and link domains were registered"
          />
          <CalendarClock className="h-4 w-4 mt-0.5 flex-shrink-0 text-muted-foreground" />
          <span>
            <span className="font-medium">Check how recently sender and link domains were registered</span>
            <span className="block text-xs text-muted-foreground">
              Asks the domain&rsquo;s registry (RDAP), once a month per domain. A domain registered
              days ago is the tell no blocklist has yet; it adds points, never the whole verdict.
              Not a blocklist, so the switch above does not govern it.
            </span>
          </span>
        </label>
      </section>
    </div>
  );
}
