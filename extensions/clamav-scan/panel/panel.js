/* global window, document */
(function () {
  'use strict';
  var security = window.sarv.security;
  var byId = function (id) { return document.getElementById(id); };
  var setup = null;
  var targets = [];
  var job = null;
  var submitting = false;
  var cancelling = false;
  var refreshVersion = 0;
  var timer = null;
  var expiryTimer = null;
  var pollVersion = 0;
  var stopped = false;
  var terminal = ['completed', 'cancelled', 'error', 'expired'];
  var stateLabels = { preparing: 'Preparing', uploading: 'Uploading', queued: 'Queued', scanning: 'Scanning', completed: 'Completed', cancelled: 'Cancelled', error: 'Error', expired: 'Expired' };
  var verdictLabels = { pending: 'Waiting for a result', 'no-threat-detected': 'No threat detected', 'threat-detected': 'Threat detected', incomplete: 'Incomplete scan', error: 'Scan error' };

  function showError(error) {
    byId('error').textContent = error ? (error.message || String(error)) : '';
    byId('error').hidden = !error;
  }
  function active() { return Boolean(submitting || (job && terminal.indexOf(job.state) === -1)); }
  function selected() { return Array.from(document.querySelectorAll('#targets input:checked')).map(function (input) { return input.value; }); }
  function bodySelected(ids) { return targets.some(function (target) { return target.kind === 'email-body' && ids.indexOf(target.targetId) !== -1; }); }
  function updateActions() {
    var ids = selected();
    var body = bodySelected(ids);
    byId('body-consent-row').hidden = !body;
    byId('body-consent').disabled = active();
    if (!body) byId('body-consent').checked = false;
    byId('scan').disabled = !setup || !setup.enabled || !ids.length || active() || (body && !byId('body-consent').checked);
    byId('scan').textContent = submitting ? 'Preparing…' : 'Scan selected';
    byId('cancel').hidden = !job || terminal.indexOf(job.state) !== -1;
    byId('cancel').disabled = cancelling;
    byId('cancel').textContent = cancelling ? 'Cancelling…' : 'Cancel scan';
  }
  function formatBytes(bytes) {
    if (bytes === null) return 'Size determined before upload';
    if (bytes < 1024) return bytes + ' bytes';
    return (bytes / 1024).toFixed(1) + ' KB';
  }
  function renderTargets() {
    var nodes = targets.map(function (target) {
      var label = document.createElement('label');
      label.className = 'target';
      var input = document.createElement('input');
      input.type = 'checkbox'; input.value = target.targetId;
      var unavailable = target.unavailableReason || (target.kind === 'email-body' && setup && !setup.allowBody ? 'Enable body sharing in scanner setup to select this target.' : '');
      input.disabled = Boolean(unavailable);
      if (unavailable) label.className += ' target-unavailable';
      input.addEventListener('change', updateActions);
      var text = document.createElement('span');
      var name = document.createElement('span'); name.className = 'target-name'; name.textContent = target.displayName;
      var meta = document.createElement('span'); meta.className = 'target-meta';
      meta.textContent = unavailable || ((target.kind === 'email-body' ? 'Body text · ' : 'Attachment · ') + formatBytes(target.byteLength));
      text.append(name, meta); label.append(input, text); return label;
    });
    byId('targets').replaceChildren.apply(byId('targets'), nodes);
    byId('target-summary').textContent = targets.length ? 'Select only what you want to share. Nothing is selected automatically.' : 'Open a message with an available scan target.';
    byId('body-consent').checked = false;
    updateActions();
  }
  function renderSetup() {
    byId('service-state').textContent = setup && setup.enabled ? 'Scanner enabled' : 'Setup required';
    byId('service-info').textContent = setup && setup.operator ? setup.operator + (setup.region ? ' · ' + setup.region : '') : 'Choose a scanner and review sharing consent in the app.';
    byId('sharing-note').textContent = setup && setup.enabled ? 'Selected bytes leave this device for ' + (setup.operator || 'your configured scanner') + ' when you start a scan.' : 'Configure the service and choose which accounts may share files before scanning.';
  }
  function invalidateVerdict(state, reason) {
    if (!job) return;
    job = Object.assign({}, job, { state: state, error: reason, items: job.items.map(function (item) {
      return { targetId: item.targetId, displayName: item.displayName, kind: item.kind, status: 'error', reason: reason };
    }) });
  }
  function expireJobIfNeeded() {
    if (!job || !job.expiresAt || Date.now() < new Date(job.expiresAt).getTime()) return false;
    invalidateVerdict('expired', 'Result expired; no current verdict is available.');
    pollVersion += 1; clearTimeout(timer); return true;
  }
  function renderJob() {
    if (!job) return;
    clearTimeout(expiryTimer);
    if (!expireJobIfNeeded() && job.expiresAt) {
      var remaining = new Date(job.expiresAt).getTime() - Date.now();
      if (remaining > 0) expiryTimer = setTimeout(function () { renderJob(); }, Math.min(remaining, 2147483647));
    }
    byId('job').hidden = false;
    byId('job-state').textContent = stateLabels[job.state] || job.state;
    var nodes = job.items.map(function (item) {
      var row = document.createElement('div'); row.className = 'result'; row.dataset.status = item.status;
      var name = document.createElement('div'); name.className = 'result-name'; name.textContent = item.displayName;
      var status = document.createElement('p'); status.className = 'result-status'; status.textContent = verdictLabels[item.status] || item.status;
      row.append(name, status);
      if (item.reason) { var reason = document.createElement('p'); reason.className = 'muted'; reason.textContent = item.reason; row.append(reason); }
      if (item.signatures && item.signatures.length) { var signatures = document.createElement('p'); signatures.className = 'muted'; signatures.textContent = 'Signatures: ' + item.signatures.join(', '); row.append(signatures); }
      if (item.completedAt) { var scanned = document.createElement('p'); scanned.className = 'muted'; scanned.textContent = 'Scanned ' + new Date(item.completedAt).toLocaleString(); row.append(scanned); }
      if (item.engine) {
        var engine = document.createElement('p'); engine.className = 'muted';
        engine.textContent = item.engine.name + ' ' + item.engine.version + ' · Definitions ' + item.engine.signatureVersion + ' · Updated ' + new Date(item.engine.signaturesUpdatedAt).toLocaleString();
        row.append(engine);
      }
      if (item.sha256 || item.bytes !== undefined) {
        var details = document.createElement('details'); details.className = 'muted';
        var summary = document.createElement('summary'); summary.textContent = 'Scan details'; details.append(summary);
        if (item.bytes !== undefined) { var bytes = document.createElement('p'); bytes.textContent = 'Scanned bytes: ' + item.bytes; details.append(bytes); }
        if (item.sha256) { var hash = document.createElement('p'); hash.className = 'fingerprint'; hash.textContent = 'SHA-256: ' + item.sha256; details.append(hash); }
        if (item.engine) { var policy = document.createElement('p'); policy.textContent = 'Scan policy: ' + item.engine.scanPolicyVersion; details.append(policy); }
        row.append(details);
      }
      return row;
    });
    byId('results').replaceChildren.apply(byId('results'), nodes);
    byId('job-detail').textContent = job.error || ('Updated ' + new Date(job.updatedAt).toLocaleString() + (job.expiresAt ? ' · Result expires ' + new Date(job.expiresAt).toLocaleString() : ''));
    updateActions();
  }
  async function pollJob(id, version) {
    if (version === undefined) version = ++pollVersion;
    clearTimeout(timer);
    if (expireJobIfNeeded()) { renderJob(); return; }
    try {
      var latest = await security.get(id);
      if (stopped || version !== pollVersion || !job || job.id !== id) return;
      job = latest; renderJob();
      if (terminal.indexOf(job.state) === -1) timer = setTimeout(function () { void pollJob(id, version); }, 1000);
    } catch (error) {
      if (!stopped && version === pollVersion) {
        invalidateVerdict('error', 'Scan status is unavailable; no usable verdict can be shown. Refresh to check again.');
        renderJob(); showError(error);
      }
    }
  }
  async function refresh() {
    var version = ++refreshVersion;
    byId('refresh').disabled = true;
    showError(null);
    try {
      var values = await Promise.all([security.getSetup(), security.getTargets()]);
      if (version !== refreshVersion) return;
      setup = values[0]; targets = values[1]; renderSetup(); renderTargets();
      if (job) void pollJob(job.id);
    } catch (error) {
      if (version === refreshVersion) { targets = []; renderTargets(); showError(error); }
    } finally { if (version === refreshVersion) byId('refresh').disabled = false; }
  }
  byId('configure').addEventListener('click', async function () {
    showError(null);
    try { await security.openSetup(); byId('sharing-note').textContent = 'After saving setup in the app, choose Refresh to load the scanner settings.'; }
    catch (error) { showError(error); }
  });
  byId('refresh').addEventListener('click', function () { void refresh(); });
  byId('body-consent').addEventListener('change', updateActions);
  byId('scan').addEventListener('click', async function () {
    if (byId('scan').disabled) return;
    var ids = selected();
    var includeBodyConsent = bodySelected(ids) && byId('body-consent').checked;
    byId('body-consent').checked = false;
    submitting = true; showError(null); updateActions();
    try { var created = await security.submit(ids, { includeBodyConsent: includeBodyConsent }); if (stopped) return; job = created; renderJob(); if (terminal.indexOf(job.state) === -1) void pollJob(job.id); }
    catch (error) { showError(error); }
    finally { submitting = false; updateActions(); }
  });
  byId('cancel').addEventListener('click', async function () {
    if (!job || cancelling || terminal.indexOf(job.state) !== -1) return;
    cancelling = true; pollVersion += 1; clearTimeout(timer); updateActions(); showError(null);
    try { job = await security.cancel(job.id); renderJob(); if (terminal.indexOf(job.state) === -1) void pollJob(job.id); }
    catch (error) { invalidateVerdict('error', 'Cancellation status is unavailable; no usable verdict can be shown. Refresh to check again.'); renderJob(); showError(error); }
    finally { cancelling = false; updateActions(); }
  });
  window.sarv.on('message-changed', function () { void refresh(); });
  window.addEventListener('focus', function () { void refresh(); });
  window.addEventListener('pagehide', function () { stopped = true; pollVersion += 1; refreshVersion += 1; clearTimeout(timer); clearTimeout(expiryTimer); });
  void refresh();
})();
