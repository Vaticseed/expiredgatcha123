// Daily rank updater for the dodge-list.
// Reads every entry from Firestore, looks up its current Valorant rank
// via the HenrikDev API, and writes the result back. Paced to stay
// safely under HenrikDev's 30 requests/minute limit on a Basic key.
//
// Run by the GitHub Actions workflow in
// .github/workflows/update-ranks.yml on a daily schedule.
// Can also be run manually: node scripts/update-ranks.mjs

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const HENRIK_API_KEY = process.env.HENRIK_API_KEY;
const FIREBASE_SERVICE_ACCOUNT = process.env.FIREBASE_SERVICE_ACCOUNT;
const REGION = 'eu';
const DELAY_MS = 2200; // ~27 requests/minute, safely under the 30/min cap

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

async function fetchRank(username, tag) {
  const url = `https://api.henrikdev.xyz/valorant/v2/mmr/${REGION}/${encodeURIComponent(username)}/${encodeURIComponent(tag)}`;
  const res = await fetch(url, { headers: { Authorization: HENRIK_API_KEY } });
  const json = await res.json();
  if (!res.ok || !json.data) {
    throw new Error(json?.errors?.[0]?.message || `HTTP ${res.status}`);
  }
  const current = json.data.current_data || {};
  return {
    rank: current.currenttier_patched || 'Unrated',
    rankImage: current.images?.small || null,
  };
}

async function main() {
  const snapshot = await db.collection('entries').get();
  const entries = snapshot.docs;
  console.log(`Found ${entries.length} entries. Updating ranks, ~${DELAY_MS}ms apart...`);

  let updated = 0;
  let failed = 0;

  for (const docSnap of entries) {
    const data = docSnap.data();
    if (!data.username || !data.tag) continue;

    try {
      const { rank, rankImage } = await fetchRank(data.username, data.tag);
      await docSnap.ref.update({
        rank,
        rankImage,
        rankCheckedAt: Date.now(),
      });
      updated++;
      console.log(`OK  ${data.username}#${data.tag} -> ${rank}`);
    } catch (err) {
      failed++;
      console.warn(`FAIL ${data.username}#${data.tag}: ${err.message}`);
    }

    await sleep(DELAY_MS);
  }

  console.log(`Done. Updated: ${updated}, Failed: ${failed}, Total: ${entries.length}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
