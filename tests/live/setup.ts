import { config } from 'dotenv';

// Live tests run outside Next.js, so .env is not auto-loaded. Pull it in here
// (same file the dev server uses) before any test module reads process.env.
config();
