import { BLOCKLISTS } from '@sarv-in/mailguard/reputation';
import { Globe, Info, Server } from 'lucide-react';
import { useState } from 'react';

import { getReputationPrefs, setReputationPrefs } from '../../store/helpers';
import { Tooltip } from '../Tooltip';

/**
 * Blocklists — the one spam check that leaves this machine.
 *
 * Every other stage of the filter reads the message that already arrived. This
 * one asks an operator, over DNS, about the server that delivered it and the
 * domain it claims to be from. That is a real disclosure: the operator learns,
 * in near real time, who writes to this user. So the tab is written to be read
 * before it is switched on, and it starts off.
 *
 * The resolver field is not a power-user detail. Spamhaus and its peers refuse
 * queries that arrive through a public or open resolver — an ISP's DNS, or
 * 8.8.8.8 — which is the normal setup on a home connection. Enabling this
 * without a resolver of one's own usually means every query is refused, the
 * breaker opens, and nothing is scored. Saying so here is cheaper than letting
 * somebody discover it as a silence.
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
              server&rsquo;s address, and the sender&rsquo;s domain, to a blocklist operator over DNS
              — so that operator learns who writes to you, as it happens. Nothing is asked until
              you pick at least one list below.
            </p>
            <p>
              A listing adds to a message&rsquo;s spam score. It is never the whole verdict on its
              own: a shared mail server appears on a list for reasons that have nothing to do with
              the person who wrote to you.
            </p>
          </div>
        </div>
      </section>

      <section>
        <label className="flex items-center gap-3 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={prefs.enabled}
            onChange={(event) => save({ ...prefs, enabled: event.target.checked })}
            className="h-4 w-4 accent-primary"
            aria-label="Query blocklists for incoming mail"
          />
          <span className="font-medium">Query these lists for incoming mail</span>
        </label>
        {prefs.enabled && prefs.zones.length === 0 && (
          <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
            No list is selected, so nothing will be queried.
          </p>
        )}
      </section>

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
                    {list.kind === 'ip' ? 'sending servers' : 'sender domains'}
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
              listing, and Sarv Inbox reads it as a refusal, but it does mean nothing gets scored.
              Point this at a resolver of your own to get answers.
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
    </div>
  );
}
