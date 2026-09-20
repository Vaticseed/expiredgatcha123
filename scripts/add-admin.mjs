import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

const username = (process.env.ADMIN_USERNAME || '').trim().toLowerCase();
const remove = process.env.REMOVE === 'true';
if (!/^[a-z0-9._-]+$/.test(username)) { console.error('Bad username'); process.exit(1); }

initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const auth = getAuth();
const email = `${username}@dodgelist.local`;
const user = await auth.getUserByEmail(email);
await auth.setCustomUserClaims(user.uid, { admin: !remove });
console.log(`${email}: admin=${!remove}`);
