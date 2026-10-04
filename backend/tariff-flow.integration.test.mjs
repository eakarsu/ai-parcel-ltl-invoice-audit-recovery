import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';

test('two customers keep tariff evidence, assessments, claims, and credits isolated', {
  skip: !process.env.RECOVERY_INTEGRATION_DATABASE_URL,
}, async () => {
  process.env.DATABASE_URL = process.env.RECOVERY_INTEGRATION_DATABASE_URL;
  process.env.APP_TEST_NO_LISTEN = 'true';
  const { app, pool } = await import('./server.mjs');
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path, token, body, method = 'GET') {
    const response = await fetch(base + path, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: await response.json() };
  }
  const post = (path, token, body) => request(path, token, body, 'POST');
  const quoteFuel = 'Northstar Parcel Fuel surcharge 12.5% of base freight from 2026-01-01 through 2026-12-31';
  const quoteFixed = 'Northstar Parcel Residential surcharge $5.00 per shipment from 2026-01-01 through 2026-12-31';
  const sourceText = `${quoteFuel}\n${quoteFixed}\n`;
  const rateBody = (sourceId, featureId, chargeType, rate, sourceQuote) => ({
    sourceId, featureId, carrier: 'Northstar Parcel', chargeType, rate,
    effectiveOn: '2026-01-01', expiresOn: '2026-12-31', sourceQuote,
  });
  try {
    const password = `Test-${randomUUID()}`;
    const ref = `PARCEL-${randomUUID()}`;
    const refSecond = `PARCEL-${randomUUID()}`;
    const refFixed = `PARCEL-${randomUUID()}`;
    const refDuplicate = `PARCEL-${randomUUID()}`;
    const accounts = [];
    for (const name of ['A', 'B']) {
      const account = { id: randomUUID(), adminEmail: `${name.toLowerCase()}-${randomUUID()}@example.test`, reviewerEmail: `${name.toLowerCase()}-review-${randomUUID()}@example.test` };
      await pool.query('INSERT INTO customer_accounts(id,name) VALUES($1,$2)', [account.id, `Tariff customer ${name}`]);
      for (const [email, role] of [[account.adminEmail, 'admin'], [account.reviewerEmail, 'reviewer']]) {
        await pool.query('INSERT INTO app_users(account_id,email,password_hash,name,role) VALUES($1,$2,$3,$4,$5)',
          [account.id, email, await bcrypt.hash(password, 4), email, role]);
      }
      for (const [featureId, reference] of [['fuel-surcharge-audit', ref], ['fuel-surcharge-audit', refSecond],
        ['accessorial-charge-validation', refFixed], ['accessorial-charge-validation', refDuplicate]]) {
        await pool.query(`INSERT INTO feature_records(account_id,feature_id,reference,title,status,owner,risk,due_date,amount,payload)
          VALUES($1,$2,$3,'Tariff test case','Open',$4,'Not assessed',current_date+30,15.30,$5)`,
        [account.id, featureId, reference, emailFor(account), { carrier: 'Northstar Parcel',
          contractFuelPercent: 12.5, baseFreightAmount: 100, supportedAmount: 5 }]);
      }
      account.admin = (await post('/api/auth/login', null, { email: account.adminEmail, password })).data.token;
      account.reviewer = (await post('/api/auth/login', null, { email: account.reviewerEmail, password })).data.token;
      assert.ok(account.admin && account.reviewer);
      accounts.push(account);
    }
    const [a, b] = accounts;
    const sourceA = await post('/api/parcel/tariff-sources', a.admin, { sourceFile: 'carrier-rates.txt', content: sourceText });
    const sourceB = await post('/api/parcel/tariff-sources', b.admin, { sourceFile: 'carrier-rates.txt', content: sourceText });
    assert.equal(sourceA.status, 201);
    assert.equal(sourceB.status, 201);
    assert.equal(sourceA.data.source.content_hash, sourceB.data.source.content_hash);
    assert.equal(sourceA.data.source.content_hash, createHash('sha256').update(sourceText).digest('hex'));
    assert.notEqual(sourceA.data.source.id, sourceB.data.source.id);
    assert.equal((await request(`/api/parcel/tariff-sources/${sourceB.data.source.id}`, a.admin)).status, 404);
    assert.equal((await post('/api/parcel/tariff-rules', a.admin,
      rateBody(sourceB.data.source.id, 'fuel-surcharge-audit', 'Fuel surcharge', '12.5', quoteFuel))).status, 409);
    assert.equal((await post('/api/parcel/tariff-rules', a.admin,
      rateBody(sourceA.data.source.id, 'fuel-surcharge-audit', 'Fuel surcharge', '12.5', quoteFuel + ' altered'))).status, 422);

    const fuelStatement = `reference,description,charge_type,base_freight_amount,amount,date\n${ref},Fuel charge,Fuel surcharge,100.00,15.30,2026-07-18\n`;
    const ingestA = await post('/api/features/fuel-surcharge-audit/ingest', a.admin,
      { text: fuelStatement, sourceFile: 'parcel-invoice.csv' });
    const ingestB = await post('/api/features/fuel-surcharge-audit/ingest', b.admin,
      { text: fuelStatement, sourceFile: 'parcel-invoice.csv' });
    assert.equal(ingestA.status, 201);
    assert.equal(ingestB.status, 201);
    assert.equal(ingestA.data.checksum, ingestB.data.checksum);
    const aLine = (await request(`/api/statement-ingests/${ingestA.data.ingestId}`, a.admin)).data.lines[0];
    const bLine = (await request(`/api/statement-ingests/${ingestB.data.ingestId}`, b.admin)).data.lines[0];
    assert.equal(aLine.reconciliation_status, 'assumed_no_rule', 'typed case fuel terms cannot bypass tariff review');
    assert.notEqual(aLine.id, bLine.id);
    assert.equal((await post('/api/claims', a.admin, { statementLineId: aLine.id })).status, 400);
    assert.equal((await request('/api/claims/candidates', a.admin)).data.items.filter(item => item.feature_id === 'fuel-surcharge-audit').length, 0);

    const draftA = await post('/api/parcel/tariff-rules', a.admin,
      rateBody(sourceA.data.source.id, 'fuel-surcharge-audit', 'Fuel surcharge', '12.5', quoteFuel));
    assert.equal(draftA.status, 201);
    const ruleA = draftA.data.rule;
    assert.equal(ruleA.source_line, 1);
    assert.equal(ruleA.version, 1);
    assert.equal((await request(`/api/parcel/tariff-rules/${ruleA.id}/assessments`, b.admin)).status, 404);
    assert.equal((await post(`/api/parcel/tariff-rules/${ruleA.id}/approve`, a.admin,
      { rationale: 'Reviewed the exact quoted rate and dates against the imported file.' })).status, 403);
    assert.equal((await post(`/api/parcel/tariff-rules/${ruleA.id}/approve`, a.reviewer,
      { rationale: 'Reviewed the exact quoted rate and dates against the imported file.' })).status, 200);
    assert.equal((await post(`/api/parcel/tariff-rules/${ruleA.id}/assess`, a.admin, {})).data.newAssessments, 1);
    const fuelAssessment = (await request(`/api/parcel/tariff-rules/${ruleA.id}/assessments`, a.admin)).data.items[0];
    assert.equal(fuelAssessment.variance_cents, '280');
    assert.equal(fuelAssessment.calculation.sourceQuote, quoteFuel);
    assert.equal(fuelAssessment.calculation.statementChecksum, ingestA.data.checksum);
    assert.equal((await request('/api/dashboard', a.admin)).data.totals.confirmed_recovery, 2.8);
    assert.equal((await request('/api/dashboard', b.admin)).data.totals.confirmed_recovery, 0);
    const candidateA = (await request('/api/claims/candidates', a.admin)).data.items.find(item => item.id === aLine.id);
    assert.equal(candidateA.parcel_assessment_id, fuelAssessment.id);
    assert.equal(Number(candidateA.delta), 2.8);
    assert.equal((await post('/api/claims', b.admin,
      { statementLineId: aLine.id, parcelAssessmentId: fuelAssessment.id })).status, 409);
    const claimA = await post('/api/claims', a.admin,
      { statementLineId: aLine.id, parcelAssessmentId: fuelAssessment.id });
    assert.equal(claimA.status, 201);
    assert.equal(Number(claimA.data.claim.requested_cents), 280);
    assert.equal((await request(`/api/claims/${claimA.data.claim.id}`, b.admin)).status, 404);

    const draftB = await post('/api/parcel/tariff-rules', b.admin,
      rateBody(sourceB.data.source.id, 'fuel-surcharge-audit', 'Fuel surcharge', '12.5', quoteFuel));
    assert.equal(draftB.status, 201);
    assert.equal((await post(`/api/parcel/tariff-rules/${draftB.data.rule.id}/approve`, b.reviewer,
      { rationale: 'Independently reviewed the source quote, date window and percent.' })).status, 200);
    assert.equal((await post(`/api/parcel/tariff-rules/${draftB.data.rule.id}/assess`, b.admin, {})).data.newAssessments, 1);
    const candidateB = (await request('/api/claims/candidates', b.admin)).data.items.find(item => item.id === bLine.id);
    assert.equal(Number(candidateB.delta), 2.8);
    assert.notEqual(candidateB.parcel_assessment_id, fuelAssessment.id);

    const fixedDraft = await post('/api/parcel/tariff-rules', a.admin,
      rateBody(sourceA.data.source.id, 'accessorial-charge-validation', 'Residential surcharge', '5.00', quoteFixed));
    assert.equal(fixedDraft.status, 201);
    assert.equal((await post(`/api/parcel/tariff-rules/${fixedDraft.data.rule.id}/approve`, a.reviewer,
      { rationale: 'Independently checked the exact residential fee and validity dates.' })).status, 200);
    const fixedText = `reference,description,charge_type,amount,date\n${refFixed},Residential,Residential surcharge,7.00,2026-07-18\n${refDuplicate},Residential,Residential surcharge,7.00,2026-07-18\n`;
    const fixedIngest = await post('/api/features/accessorial-charge-validation/ingest', a.admin,
      { text: fixedText, sourceFile: 'accessorial.csv' });
    assert.equal(fixedIngest.status, 201);
    assert.equal((await post(`/api/parcel/tariff-rules/${fixedDraft.data.rule.id}/assess`, a.admin, {})).data.newAssessments, 2);
    const fixedAssessments = (await request(`/api/parcel/tariff-rules/${fixedDraft.data.rule.id}/assessments`, a.admin)).data.items;
    assert.ok(fixedAssessments.every(item => item.status === 'CANDIDATE' && Number(item.variance_cents) === 200));
    const fixedLines = (await request(`/api/statement-ingests/${fixedIngest.data.ingestId}`, a.admin)).data.lines;
    const duplicateLine = fixedLines.find(item => item.record_reference === refDuplicate);
    const duplicateAssessment = fixedAssessments.find(item => item.statement_line_id === duplicateLine.id);
    const secondCharge = `reference,description,charge_type,amount,date\n${refDuplicate},Residential again,Residential surcharge,7.00,2026-07-18\n`;
    assert.equal((await post('/api/features/accessorial-charge-validation/ingest', a.admin,
      { text: secondCharge, sourceFile: 'accessorial-duplicate.csv' })).status, 201);
    assert.equal((await request('/api/claims/candidates', a.admin)).data.items.some(item => item.id === duplicateLine.id), false);
    assert.equal((await post('/api/claims', a.admin,
      { statementLineId: duplicateLine.id, parcelAssessmentId: duplicateAssessment.id })).status, 409);

    const secondFuelText = `reference,description,charge_type,base_freight_amount,amount,date\n${refSecond},Fuel charge,Fuel surcharge,100.00,15.30,2026-07-18\n`;
    const secondFuelIngest = await post('/api/features/fuel-surcharge-audit/ingest', a.admin,
      { text: secondFuelText, sourceFile: 'parcel-second-invoice.csv' });
    assert.equal(secondFuelIngest.status, 201);
    const secondFuelLine = (await request(`/api/statement-ingests/${secondFuelIngest.data.ingestId}`, a.admin)).data.lines[0];
    assert.equal((await post(`/api/parcel/tariff-rules/${ruleA.id}/assess`, a.admin, {})).data.newAssessments, 1);
    const oldCandidate = (await request('/api/claims/candidates', a.admin)).data.items.find(item => item.id === secondFuelLine.id);
    assert.equal(Number(oldCandidate.delta), 2.8);
    const quoteV2 = 'Northstar Parcel Fuel surcharge 13% of base freight from 2026-01-01 through 2026-12-31';
    const sourceV2 = await post('/api/parcel/tariff-sources', a.admin,
      { sourceFile: 'carrier-rates-v2.txt', content: `${quoteV2}\n` });
    assert.equal(sourceV2.status, 201);
    const draftV2 = await post('/api/parcel/tariff-rules', a.admin,
      rateBody(sourceV2.data.source.id, 'fuel-surcharge-audit', 'Fuel surcharge', '13', quoteV2));
    assert.equal(draftV2.status, 201);
    assert.equal(draftV2.data.rule.version, 2);
    assert.equal((await post(`/api/parcel/tariff-rules/${draftV2.data.rule.id}/approve`, a.reviewer,
      { rationale: 'Independently checked the revised exact fuel quote and validity dates.' })).status, 200);
    assert.equal((await request('/api/claims/candidates', a.admin)).data.items.some(item => item.id === secondFuelLine.id), false,
      'superseded tariff assessments must no longer offer claim candidates');
    assert.equal((await post('/api/claims', a.admin,
      { statementLineId: secondFuelLine.id, parcelAssessmentId: oldCandidate.parcel_assessment_id })).status, 409);
    assert.equal((await post(`/api/parcel/tariff-rules/${draftV2.data.rule.id}/assess`, a.admin, {})).data.newAssessments, 2);
    const currentCandidate = (await request('/api/claims/candidates', a.admin)).data.items.find(item => item.id === secondFuelLine.id);
    assert.equal(currentCandidate.tariff_version, 2);
    assert.equal(Number(currentCandidate.delta), 2.3);

    const submitted = await post(`/api/claims/${claimA.data.claim.id}/events`, a.admin,
      { eventType: 'SUBMITTED', externalReference: 'PORTAL-12345', evidenceText: 'Staff copied a portal entry, without independent carrier verification.' });
    assert.equal(submitted.status, 200);
    assert.equal((await post(`/api/claims/${claimA.data.claim.id}/events`, a.reviewer,
      { eventType: 'ACKNOWLEDGED', externalReference: 'ACK-12345', evidenceText: 'Staff copied an apparent acknowledgement from correspondence.' })).status, 200);
    const creditsText = `reference,description,charge_type,amount,date\n${ref},Wrong charge credit,Residential surcharge,-2.80,2026-07-25\n${ref},Fuel credit,Fuel surcharge,-2.80,2026-07-25\n`;
    const credits = await post('/api/features/fuel-surcharge-audit/ingest', a.admin,
      { text: creditsText, sourceFile: 'later-credit.csv' });
    assert.equal(credits.status, 201);
    const creditLines = (await request(`/api/statement-ingests/${credits.data.ingestId}`, a.admin)).data.lines;
    const wrong = creditLines.find(item => item.provenance.chargeType === 'Residential surcharge');
    const right = creditLines.find(item => item.provenance.chargeType === 'Fuel surcharge');
    const creditCandidates = (await request(`/api/claims/credit-lines?claimId=${claimA.data.claim.id}`, a.admin)).data.items;
    assert.deepEqual(creditCandidates.map(item => item.id), [right.id]);
    assert.equal((await post(`/api/claims/${claimA.data.claim.id}/credits`, a.admin,
      { creditLineId: wrong.id, issuerReference: 'CREDIT-WRONG' })).status, 409);
    const linked = await post(`/api/claims/${claimA.data.claim.id}/credits`, a.admin,
      { creditLineId: right.id, issuerReference: 'CREDIT-FUEL' });
    assert.equal(linked.status, 200);
    assert.equal(linked.data.claim.status, 'CREDIT_EVIDENCED');
    assert.equal(Number(linked.data.claim.credit_cents), 280);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await pool.end();
  }
});

function emailFor(account) { return account.adminEmail; }
