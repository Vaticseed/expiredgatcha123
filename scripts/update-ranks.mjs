// Hourly rank updater + invalid-profile cleanup for the dodge-list.
//
// For every entry:
//   - looks up the current Valorant rank via the HenrikDev API
//   - if the account genuinely doesn't exist (a real 404, not a
//     rate limit / network blip / API downtime), it does NOT delete
//     immediately. It increments a "not found" streak on the entry.
//     Only once an entry has been confirmed not-found on
//     NOT_FOUND_DELETE_THRESHOLD separate runs in a row does it get
//     deleted. This protects against deleting a real entry just
//     because of a temporary API hiccup, or because HenrikDev briefly
//     returned an error that looked like a 404 but wasn't.
//   - any other kind of error (rate limit, network, HenrikDev down)
//     is skipped and retried next run. It never counts toward deletion.
//
// Run by the GitHub Actions workflow in
// .github/workflows/update-ranks.yml on an hourly schedule.
// Can also be run manually: node scripts/update-ranks.mjs

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const HENRIK_API_KEY = process.env.HENRIK_API_KEY;
const FIREBASE_SERVICE_ACCOUNT = process.env.FIREBASE_SERVICE_ACCOUNT;
const REGION = 'eu';
const DELAY_MS = 4000; // 15 requests/minute

// How many CONSECUTIVE confirmed "account not found" runs in a row
// before an entry gets deleted. At one run/hour, 3 = roughly 3 hours
// of being confirmed gone before it's removed. Raise this if you want
// to be more cautious, lower it if you want faster cleanup.
const NOT_FOUND_DELETE_THRESHOLD = 3;

// Set to "true" to log what WOULD be deleted without actually deleting
// anything. Useful for a first run to sanity-check the behavior.
const DRY_RUN = process.env.DRY_RUN === 'true';

if (!HENRIK_API_KEY) {
  console.error('Missing HENRIK_API_KEY environment variable.');
  process.exit(1);
}
if (!FIREBASE_SERVICE_ACCOUNT) {
  console.error('Missing FIREBASE_SERVICE_ACCOUNT environment variable.');
  process.exit(1);
}

const serviceAccount = JSON.parse(FIREBASE_SERVICE_ACCOUNT);
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class AccountNotFoundError extends Error {}

async function fetchRank(username, tag) {
  const url = `https://api.henrikdev.xyz/valorant/v2/mmr/${REGION}/${encodeURIComponent(username)}/${encodeURIComponent(tag)}`;
  const res = await fetch(url, { headers: { Authorization: HENRIK_API_KEY } });

  if (res.status === 404) {
    throw new AccountNotFoundError('Account not found (404)');
  }

  const json = await res.json();
  if (!res.ok || !json.data) {
    // Any other failure (rate limit, 500, malformed response, etc)
    // is treated as a transient error, NOT as proof the account is
    // invalid, so it never counts toward deletion.
    throw new Error(json?.errors?.[0]?.message || `HTTP ${res.status}`);
  }

  const current = json.data.current_data || {};
  return {
    rank: current.currenttier_patched || 'Unrated',
    rankImage: current.images?.small || null,
    rankTier: typeof current.currenttier === 'number' ? current.currenttier : 0,
    username: json.data.name || undefined,
    tag: json.data.tag || undefined,
  };
}

async function main() {
  const snapshot = await db.collection('entries').get();
  const entries = snapshot.docs;
  console.log(`Found ${entries.length} entries. Updating ranks, ~${DELAY_MS}ms apart...${DRY_RUN ? ' (DRY RUN, no deletes)' : ''}`);

  let updated = 0;
  let failed = 0;
  let deleted = 0;
  let flaggedNotFound = 0;

  for (const docSnap of entries) {
    const data = docSnap.data();
    if (!data.username || !data.tag) continue;
    const label = `${data.username}#${data.tag}`;

    try {
      const { rank, rankImage, rankTier, username, tag } = await fetchRank(data.username, data.tag);
      const update = { rank, rankImage, rankTier, rankCheckedAt: Date.now(), notFoundStreak: 0 };
      if (username) update.username = username;
      if (tag) update.tag = tag;
      await docSnap.ref.update(update);
      updated++;
      console.log(`OK   ${label} -> ${rank}`);
    } catch (err) {
      if (err instanceof AccountNotFoundError) {
        const streak = (data.notFoundStreak || 0) + 1;
        if (streak >= NOT_FOUND_DELETE_THRESHOLD) {
          if (DRY_RUN) {
            console.warn(`WOULD DELETE ${label} (confirmed not found ${streak}x)`);
          } else {
            await docSnap.ref.delete();
            console.warn(`DELETED ${label} (confirmed not found ${streak}x)`);
          }
          deleted++;
        } else {
          await docSnap.ref.update({ notFoundStreak: streak });
          console.warn(`NOT FOUND ${label} (${streak}/${NOT_FOUND_DELETE_THRESHOLD}, not deleting yet)`);
          flaggedNotFound++;
        }
      } else {
        failed++;
        console.warn(`FAIL ${label}: ${err.message}`);
      }
    }

    await sleep(DELAY_MS);
  }

  console.log(`Done. Updated: ${updated}, Not-found (pending): ${flaggedNotFound}, Deleted: ${deleted}, Other failures: ${failed}, Total: ${entries.length}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
