/**
 * Create (or reset) an administrator account without the demo seed.
 *
 *   node dist/create-admin.js <email> <password> ["Full Name"]
 *
 * Use this to bootstrap an internet-facing deployment that runs with
 * SEED_DEMO_DATA=false and ALLOW_REGISTRATION=false.
 */
import bcrypt from 'bcryptjs';
import { prisma } from './lib/prisma';

async function main(): Promise<void> {
  const [email, password, name] = process.argv.slice(2);
  if (!email || !password) {
    console.error('Usage: node dist/create-admin.js <email> <password> ["Full Name"]');
    process.exitCode = 1;
    return;
  }
  if (password.length < 12) {
    console.error('Refusing: choose a password of at least 12 characters for an admin account.');
    process.exitCode = 1;
    return;
  }
  const normalized = email.toLowerCase();
  const passwordHash = bcrypt.hashSync(password, 12);
  const user = await prisma.user.upsert({
    where: { email: normalized },
    update: { passwordHash, role: 'ADMIN' },
    create: { email: normalized, name: name || normalized, passwordHash, role: 'ADMIN' },
  });
  console.log(`Administrator ready: ${user.email} (id ${user.id})`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
