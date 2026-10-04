/** Provision one isolated customer account and its first administrator.
 * Run after migrations with CUSTOMER_NAME, CUSTOMER_ADMIN_EMAIL and
 * CUSTOMER_ADMIN_PASSWORD in the environment. The password is never printed.
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import pg from 'pg';

const name = String(process.env.CUSTOMER_NAME || '').trim();
const email = String(process.env.CUSTOMER_ADMIN_EMAIL || '').trim().toLowerCase();
const password = String(process.env.CUSTOMER_ADMIN_PASSWORD || '');
if (name.length < 2 || name.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 16)
  throw Error('Set a customer name, valid administrator email and a password of at least 16 characters');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();
try {
  await client.query('BEGIN');
  const accountId = randomUUID();
  await client.query('INSERT INTO customer_accounts(id,name) VALUES($1,$2)', [accountId, name]);
  await client.query(`INSERT INTO app_users(account_id,email,password_hash,name,role) VALUES($1,$2,$3,$4,'admin')`,
    [accountId, email, await bcrypt.hash(password, 12), `${name} administrator`]);
  await client.query('COMMIT');
  console.log(`Customer account ${accountId} provisioned for ${email}`);
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally { client.release(); await pool.end(); }
