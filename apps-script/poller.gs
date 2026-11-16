/**
 * Stash email-sync poller — runs in the Stash Gmail account's Apps Script.
 * See apps-script/README.md for setup and docs/email-sync-plan.md §5.1 for why
 * it works the way it does.
 *
 * This script only MOVES email. Every bit of parsing lives in Stash, so a
 * parser can be fixed and old mail re-read without touching this file.
 *
 * Script Properties (Project Settings → Script Properties), never in code:
 *   STASH_URL    e.g. https://your-stash.vercel.app   (no trailing slash)
 *   STASH_TOKEN  the email-sync key from Stash → Settings → Email sync (stsh_…)
 *
 * Requires the Gmail ADVANCED service (appsscript.json enables it), because
 * labels must go on individual MESSAGES. GmailApp labels whole THREADS, and
 * banks send identically-subjected alerts that Gmail threads together —
 * labelling the thread after the first would silently skip the rest.
 */

var POLLER_VERSION = '1';
var LABEL_PROCESSED = 'stash-processed';
var LABEL_REJECTED = 'stash-rejected';
var MAX_PER_RUN = 25;
var TIME_BUDGET_MS = 45 * 1000;
var MAX_HTML_CHARS = 1000000; // ~1 MB; the server refuses > 2 MB
var SEARCH =
  'in:anywhere -label:' + LABEL_PROCESSED + ' -label:' + LABEL_REJECTED + ' newer_than:7d';

/**
 * Run ONCE by hand (and again any time triggers look broken — it's
 * idempotent): creates the labels, removes old triggers, installs `poll`
 * every minute and `heartbeat` every 15 minutes.
 */
function setup() {
  labelId_(LABEL_PROCESSED);
  labelId_(LABEL_REJECTED);
  ScriptApp.getProjectTriggers().forEach(function (t) {
    ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('poll').timeBased().everyMinutes(1).create();
  ScriptApp.newTrigger('heartbeat').timeBased().everyMinutes(15).create();
  config_(); // fail loudly now if the properties are missing
  heartbeat();
  Logger.log('Stash poller installed: poll every 1 min, heartbeat every 15 min.');
}

/** Every minute. Oldest first, at most 25 messages, 45 seconds. */
function poll() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) return; // a previous run is still going; never overlap
  var started = Date.now();
  var props = PropertiesService.getScriptProperties();
  try {
    var cfg = config_();
    var listed = Gmail.Users.Messages.list('me', { q: SEARCH, maxResults: 100 });
    var ids = (listed.messages || []).map(function (m) {
      return m.id;
    });
    // The API lists newest first. Process oldest first (best effort — the
    // server tolerates follow-ups arriving out of order).
    ids.reverse();
    ids = ids.slice(0, MAX_PER_RUN);

    var processedLabel = labelId_(LABEL_PROCESSED);
    var rejectedLabel = labelId_(LABEL_REJECTED);

    for (var i = 0; i < ids.length; i++) {
      if (Date.now() - started > TIME_BUDGET_MS) break;
      var id = ids[i];
      var message = Gmail.Users.Messages.get('me', id, { format: 'full' });
      if (!message || !message.payload) continue;

      var response = post_(cfg, '/api/ingest/email', payload_(id, message));
      var code = response.getResponseCode();

      if (code >= 200 && code < 300) {
        addLabel_(id, processedLabel);
      } else if (code === 401 || code === 403) {
        // Bad or revoked key. Stop; nothing is labelled, so the backlog is
        // retried once a new key is in Script Properties.
        props.setProperty('LAST_ERROR', 'Stash rejected the key (HTTP ' + code + ')');
        return;
      } else if (code === 429 || code >= 500) {
        // Transient: stop the run, label nothing, retry next minute.
        props.setProperty('LAST_ERROR', 'Stash was unavailable (HTTP ' + code + ')');
        return;
      } else {
        // Any other 4xx is a poison message. Label it rejected and move on so
        // it can't block the queue.
        addLabel_(id, rejectedLabel);
        props.setProperty('LAST_ERROR', 'Rejected one message (HTTP ' + code + ')');
      }
    }
    props.setProperty('LAST_POLL_AT', new Date().toISOString());
    props.deleteProperty('LAST_ERROR');
  } catch (err) {
    props.setProperty('LAST_ERROR', String(err && err.message ? err.message : err).slice(0, 500));
  } finally {
    lock.releaseLock();
  }
}

/** Every 15 minutes: tell Stash the poller is alive (and what went wrong, if anything). */
function heartbeat() {
  var props = PropertiesService.getScriptProperties();
  var cfg = config_();
  var response = post_(cfg, '/api/ingest/email/heartbeat', {
    pollerVersion: POLLER_VERSION,
    lastPollAt: props.getProperty('LAST_POLL_AT'),
    lastError: props.getProperty('LAST_ERROR'),
  });
  var code = response.getResponseCode();
  if (code === 401 || code === 403) {
    props.setProperty('LAST_ERROR', 'Stash rejected the key (HTTP ' + code + ')');
  }
}

// ---- helpers -------------------------------------------------------------

function config_() {
  var props = PropertiesService.getScriptProperties();
  var url = (props.getProperty('STASH_URL') || '').replace(/\/+$/, '');
  var token = (props.getProperty('STASH_TOKEN') || '').trim();
  if (!/^https:\/\//.test(url)) throw new Error('Set STASH_URL (https://…) in Script Properties.');
  if (token.indexOf('stsh_') !== 0) throw new Error('Set STASH_TOKEN (stsh_…) in Script Properties.');
  return { url: url, token: token };
}

function post_(cfg, path, body) {
  return UrlFetchApp.fetch(cfg.url + path, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + cfg.token },
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
    followRedirects: false,
  });
}

/**
 * The FIRST occurrence of a header. Headers are listed top-down, so for
 * Authentication-Results that is the one Gmail itself added on arrival — the
 * only one Stash trusts (lib/email/dkim.ts).
 */
function header_(headers, name) {
  var lower = name.toLowerCase();
  for (var i = 0; i < headers.length; i++) {
    if (String(headers[i].name).toLowerCase() === lower) return headers[i].value;
  }
  return null;
}

/** Decode one MIME part's body, honouring its charset. */
function decodePart_(part) {
  if (!part.body || !part.body.data) return '';
  var bytes = Utilities.base64DecodeWebSafe(part.body.data);
  var type = header_(part.headers || [], 'Content-Type') || '';
  var charset = (/charset="?([^";\s]+)"?/i.exec(type) || [])[1] || 'UTF-8';
  try {
    return Utilities.newBlob(bytes).getDataAsString(charset);
  } catch (e) {
    return Utilities.newBlob(bytes).getDataAsString('UTF-8');
  }
}

/** First text/plain and first text/html anywhere in the MIME tree. */
function bodies_(part, out) {
  out = out || { plain: '', html: '' };
  var mime = String(part.mimeType || '').toLowerCase();
  var isAttachment = part.filename && part.filename.length > 0;
  if (!isAttachment && mime === 'text/plain' && !out.plain) out.plain = decodePart_(part);
  if (!isAttachment && mime === 'text/html' && !out.html) out.html = decodePart_(part);
  (part.parts || []).forEach(function (p) {
    bodies_(p, out);
  });
  return out;
}

function payload_(id, message) {
  var headers = message.payload.headers || [];
  var body = bodies_(message.payload);
  var truncated = body.html.length > MAX_HTML_CHARS || body.plain.length > MAX_HTML_CHARS;
  return {
    gmailMessageId: id,
    rfc822MessageId: header_(headers, 'Message-ID'),
    from: header_(headers, 'From') || '',
    to: header_(headers, 'To'),
    subject: header_(headers, 'Subject') || '',
    date: new Date(Number(message.internalDate)).toISOString(),
    plainBody: body.plain.slice(0, MAX_HTML_CHARS),
    htmlBody: body.html.slice(0, MAX_HTML_CHARS),
    truncated: truncated,
    headers: {
      'Delivered-To': header_(headers, 'Delivered-To'),
      'X-Forwarded-For': header_(headers, 'X-Forwarded-For'),
      'X-Forwarded-To': header_(headers, 'X-Forwarded-To'),
      'Authentication-Results': header_(headers, 'Authentication-Results'),
      'ARC-Authentication-Results': header_(headers, 'ARC-Authentication-Results'),
    },
    pollerVersion: POLLER_VERSION,
  };
}

var labelCache_ = {};

/** The label's id, creating the label if needed. */
function labelId_(name) {
  if (labelCache_[name]) return labelCache_[name];
  var labels = Gmail.Users.Labels.list('me').labels || [];
  for (var i = 0; i < labels.length; i++) {
    if (labels[i].name === name) {
      labelCache_[name] = labels[i].id;
      return labels[i].id;
    }
  }
  var created = Gmail.Users.Labels.create(
    { name: name, labelListVisibility: 'labelShow', messageListVisibility: 'show' },
    'me',
  );
  labelCache_[name] = created.id;
  return created.id;
}

/** Label ONE message (not its thread). */
function addLabel_(messageId, labelId) {
  Gmail.Users.Messages.modify({ addLabelIds: [labelId] }, 'me', messageId);
}
