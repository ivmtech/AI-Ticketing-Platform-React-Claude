import { config } from 'dotenv';

// Live tests run outside Next.js, so the env files aren't auto-loaded. Pull
// them in here (same files the dev server uses) before any test module reads
// process.env: .env for non-sensitive config, then .env.local for secrets,
// with override so .env.local wins — matching Next.js precedence.
config();
config({ path: '.env.local', override: true });
