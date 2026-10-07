// Build-wide settings for the collaborative (collab branch) version.
//
// STORAGE_NS keeps this build's browser data apart from the main site's: both
// are served from tuengr.github.io, so they share localStorage, and testing
// the collab build must never touch people's real plans.
export const STORAGE_NS = 'projectplanner-collab';

// Firebase web-app config (phase 2). While null, shared plans use the local
// test backend: they live in this browser and are shared between its tabs
// and windows, which is enough to try the editing lock with two "users".
export const FIREBASE_CONFIG = null;

// Only these accounts may sign in.
export const ALLOWED_DOMAIN = 'trinity.edu';
