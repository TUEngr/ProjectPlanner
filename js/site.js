// The published (GitHub Pages) site: which repository it belongs to, and the
// read-only plan the owner chose to publish. Pure functions, no DOM except the
// two meta-tag readers.
//
// The build (.github/scripts/build-site.sh) writes two <meta> tags into the page:
//   pp-repo    "owner/name"          the repository this site was built from
//   pp-bundle  "data/bundle.json"    present only if the owner opted in to publishing the plan

import { planFromFiles } from './planfiles.js';

// GitHub owners: letters, digits, hyphens. Repository names: letters, digits, . _ - (never "." or "..").
export function parseSlug(value) {
  const m = /^([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+)$/.exec(String(value ?? ''));
  return m && m[2] !== '.' && m[2] !== '..' ? { owner: m[1], name: m[2], slug: `${m[1]}/${m[2]}` } : null;
}

export const repoUrl = r => `https://github.com/${r.owner}/${r.name}`;
export const codespacesUrl = r => `https://codespaces.new/${r.owner}/${r.name}`;

const meta = name => globalThis.document?.querySelector(`meta[name="${name}"]`)?.content || null;
export const pageRepo = () => parseSlug(meta('pp-repo'));
export const pageBundlePath = () => {
  const p = meta('pp-bundle');
  return p === 'data/bundle.json' ? p : null; // only the one path the build writes
};

// -> { plan, commit, generated } or null when there is nothing to show.
// Throws if a bundle is there but cannot be read, so the caller can say so.
export async function loadBundle(path, fetchFn = (...a) => fetch(...a)) {
  if (!path) return null;
  let res;
  try { res = await fetchFn(path, { cache: 'no-store' }); } catch { throw new Error('The published plan could not be loaded.'); }
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`The published plan could not be loaded (${res.status}).`);
  let b;
  try { b = await res.json(); } catch { throw new Error('The published plan is not valid JSON.'); }
  if (!b || b.format !== 1 || !b.files || typeof b.files !== 'object') throw new Error('The published plan is in an unknown format.');
  try {
    return { plan: planFromFiles(b.files), commit: typeof b.commit === 'string' ? b.commit : '', generated: typeof b.generated === 'string' ? b.generated : '' };
  } catch (e) {
    throw new Error(`The published plan is damaged: ${e.message}`);
  }
}
