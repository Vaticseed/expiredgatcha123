// Bulk-deletes unverified (Pending) entries. Verified entries are never touched.
// Run from the "Cleanup Pending" workflow in the Actions tab.
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const hours = Number(process.env.HOURS || 0); // 0 = every pending entry
const dryRun = process.env.DRY_RUN !== 'false';
const cutoff = hours ? Date.now() - hours * 3600e3 : -Infinity;
const match = process.env.MATCH ? new RegExp(process.env.MATCH, 'i') : null; // e.g. ^ExtremeUser_

initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = getFirestore();

// spammers write createdAt themselves, so anything non-numeric counts as recent
const recent = d => !(typeof d.get('createdAt') === 'number' && d.get('createdAt') < cutoff);
const pending = (await db.collection('entries').where('verified', '==', false).get()).docs
  .filter(d => recent(d) && (!match || match.test(String(d.get('username')))));

console.log(`${pending.length} pending entries${dryRun ? ' (DRY RUN, nothing deleted)' : ''}`);
for (const d of pending.slice(0, 50)) console.log(`  ${d.get('username')}#${d.get('tag')}  ${String(d.get('reason') || '').slice(0, 60)}`);

if (!dryRun) {
  const writer = db.bulkWriter();
  for (const d of pending) writer.delete(d.ref);
  await writer.close();
  console.log('Deleted.');
}
