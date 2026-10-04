import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import config from '../app.config.mjs';
import { recoveryRuleFor } from './recovery-domain.mjs';

test('customer scoped claim, correspondence, and later credit path', {
  skip: !process.env.RECOVERY_INTEGRATION_DATABASE_URL,
}, async () => {
  process.env.DATABASE_URL = process.env.RECOVERY_INTEGRATION_DATABASE_URL;
  process.env.APP_TEST_NO_LISTEN = 'true';
  const { app, pool } = await import('./server.mjs');
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, token, body, method = 'GET') => {
    const response = await fetch(base + path, {
      method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: await response.json() };
  };
  try {
    const selected = config.features.map(feature => ({ feature, rule: recoveryRuleFor(config, feature) }))
      .find(({ feature, rule }) => rule && !rule.formula && feature.fields.some(field => field.key === rule.expectedKey));
    assert.ok(selected, 'a simple supported-amount capability is required');
    const { feature, rule } = selected;
    const reference = `CASE-${randomUUID()}`;
    const actual = rule.direction === 'expected-minus-actual' ? 10 : 12.8;
    const expected = rule.direction === 'expected-minus-actual' ? 12.8 : 10;
    const customerA = randomUUID(), customerB = randomUUID();
    const password = `Test-${randomUUID()}`;
    const accounts = [
      { id: customerA, email: `a-${randomUUID()}@example.test` },
      { id: customerB, email: `b-${randomUUID()}@example.test` },
    ];
    for (const account of accounts) {
      await pool.query('INSERT INTO customer_accounts(id,name) VALUES($1,$2)', [account.id, account.email]);
      await pool.query("INSERT INTO app_users(account_id,email,password_hash,name,role) VALUES($1,$2,$3,$4,'admin')",
        [account.id, account.email, await bcrypt.hash(password, 4), account.email]);
      await pool.query(`INSERT INTO feature_records(account_id,feature_id,reference,title,status,owner,risk,due_date,amount,payload)
        VALUES($1,$2,$3,'Integration case','Open',$4,'Not assessed',current_date+30,$5,$6)`,
      [account.id, feature.id, reference, account.email, actual, { [rule.expectedKey]: expected }]);
      account.token = (await request('/api/auth/login', null, { email: account.email, password }, 'POST')).data.token;
      assert.ok(account.token);
    }
    const source = `reference,description,amount,date\n${reference},Source charge,${actual},2026-07-18\n`;
    const path = `/api/features/${feature.id}/ingest`;
    const ingestedA = await request(path, accounts[0].token, { text: source, sourceFile: 'issuer.csv' }, 'POST');
    const ingestedB = await request(path, accounts[1].token, { text: source, sourceFile: 'issuer.csv' }, 'POST');
    assert.equal(ingestedA.status, 201);
    assert.equal(ingestedB.status, 201, 'same checksum must be allowed in another account');
    assert.equal(ingestedA.data.checksum, ingestedB.data.checksum);
    const bIngestFromA = await request(`/api/statement-ingests/${ingestedB.data.ingestId}`, accounts[0].token);
    assert.equal(bIngestFromA.status, 404);
    const candidatesA = await request('/api/claims/candidates', accounts[0].token);
    const candidatesB = await request('/api/claims/candidates', accounts[1].token);
    assert.equal(candidatesA.data.items.length, 1);
    assert.equal(candidatesB.data.items.length, 1);
    const aLine = candidatesA.data.items[0], bLine = candidatesB.data.items[0];
    assert.notEqual(aLine.id, bLine.id);
    await assert.rejects(pool.query(`INSERT INTO recovery_claims(account_id,feature_id,record_reference,statement_line_id,requested_cents,created_by)
      VALUES($1,$2,$3,$4,280,'integration')`, [customerA, feature.id, reference, bLine.id]), { code: '23503' });
    assert.equal((await request('/api/claims', accounts[0].token, { statementLineId: bLine.id }, 'POST')).status, 409);
    const claimA = await request('/api/claims', accounts[0].token, { statementLineId: aLine.id }, 'POST');
    const claimB = await request('/api/claims', accounts[1].token, { statementLineId: bLine.id }, 'POST');
    assert.equal(claimA.status, 201);
    assert.equal(claimB.status, 201);
    assert.equal((await request(`/api/claims/${claimB.data.claim.id}`, accounts[0].token)).status, 404);
    const eventPath = `/api/claims/${claimA.data.claim.id}/events`;
    assert.equal((await request(eventPath, accounts[0].token, { eventType: 'SUBMITTED', externalReference: 'PORTAL-12345', evidenceText: 'Claim entered into the issuer portal on the recorded date.' }, 'POST')).status, 200);
    assert.equal((await request(eventPath, accounts[0].token, { eventType: 'ACKNOWLEDGED', externalReference: 'ACK-12345', evidenceText: 'Issuer acknowledgement copied from portal message.' }, 'POST')).status, 200);
    const creditFile = `reference,description,amount,date\n${reference},First credit,-1.30,2026-07-25\n${reference},Second credit,-1.50,2026-07-25\n`;
    assert.equal((await request(path, accounts[0].token, { text: creditFile, sourceFile: 'issuer-credit.csv' }, 'POST')).status, 201);
    const creditCandidates = await request(`/api/claims/credit-lines?claimId=${claimA.data.claim.id}`, accounts[0].token);
    assert.equal(creditCandidates.data.items.length, 2);
    const first = await request(`/api/claims/${claimA.data.claim.id}/credits`, accounts[0].token,
      { creditLineId: creditCandidates.data.items[0].id, issuerReference: 'CREDIT-12345' }, 'POST');
    assert.equal(first.status, 200);
    assert.equal(first.data.claim.status, 'PARTIAL_CREDIT');
    const linked = await request(`/api/claims/${claimA.data.claim.id}/credits`, accounts[0].token,
      { creditLineId: creditCandidates.data.items[1].id, issuerReference: 'CREDIT-12346' }, 'POST');
    assert.equal(linked.status, 200);
    assert.equal(linked.data.claim.status, 'CREDIT_EVIDENCED');
    assert.equal(Number(linked.data.claim.credit_cents), 280);
    assert.equal((await request(`/api/claims/${claimB.data.claim.id}`, accounts[1].token)).data.claim.status, 'DRAFT');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await pool.end();
  }
});
