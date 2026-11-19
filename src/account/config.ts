/**
 * Where the BEV accounts service lives. Empty = accounts are switched off in
 * this build and the app works without signing in.
 *
 * After deploying it (docs/ACCOUNTS.md), put its address here, e.g.
 * "https://bev-accounts.yourname.workers.dev", and release: from then on the
 * app asks everyone to sign in with Discord.
 */
export const ACCOUNTS_URL = "";

export const accountsEnabled = () => ACCOUNTS_URL.trim() !== "";
