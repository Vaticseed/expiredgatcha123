import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { readFileSync } from 'fs';

// node scripts/add-admin.mjs <username> [password] [--remove]
const args = process.argv.slice(2);
const remove = args.includes('--remove');
const [username, password] = args.filter(a => !a.startsWith('--'));

initializeApp({ credential: cert(JSON.parse(readFileSync('./service-account.json', 'utf8'))) });
const auth = getAuth();
const email = `${username.toLowerCase()}@dodgelist.local`;

let user;
try {
  user = await auth.getUserByEmail(email);
  if (password) await auth.updateUser(user.uid, { password });
} catch {
  if (!password) throw new Error('New user needs a password');
  user = await auth.createUser({ email, password });
}
await auth.setCustomUserClaims(user.uid, { admin: !remove });
console.log(`${email}: admin=${!remove}`);
