// Editing lock for shared plans (turn-taking). One person at a time holds the
// lock and may change the plan; everyone else views it and sees saved changes.
//
// A lock records the holder's browser session (one per tab), who they are,
// and a heartbeat the holder refreshes while the tab is open. A lock whose
// heartbeat is older than LOCK_TTL_MS is stale (closed tab, sleeping laptop,
// lost connection) and anyone allowed to edit may take it over.
//
// Lock = { session, email, name, since, heartbeat }   (times are ms since epoch)

export const HEARTBEAT_MS = 30 * 1000;        // holder refreshes this often
export const LOCK_TTL_MS = 2 * 60 * 1000;     // no heartbeat for this long = stale
export const IDLE_RELEASE_MS = 15 * 60 * 1000; // holder stops editing after this much inactivity

// 'free' | 'mine' | 'held' | 'stale'
export function lockStatus(lock, session, now = Date.now(), ttl = LOCK_TTL_MS) {
  if (!lock || !lock.session) return 'free';
  if (lock.session === session) return 'mine';
  return now - (lock.heartbeat || 0) > ttl ? 'stale' : 'held';
}

export const canTakeLock = status => status === 'free' || status === 'stale' || status === 'mine';

export function newLock(session, user, now = Date.now()) {
  return { session, email: user.email, name: user.name || user.email, since: now, heartbeat: now };
}

// Roles on a shared plan. Owners and editors may take the lock; viewers may not.
export const ROLES = ['owner', 'editor', 'viewer'];
export const canEdit = role => role === 'owner' || role === 'editor';

export function emailAllowed(email, domain) {
  return typeof email === 'string' && new RegExp(`^[^@\\s]+@${domain.replace(/\./g, '\\.')}$`, 'i').test(email.trim());
}
