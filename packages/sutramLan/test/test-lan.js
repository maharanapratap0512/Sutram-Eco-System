'use strict';

const assert = require('node:assert');
const { SutramLan, LanSecurity } = require('../index');

async function runTests() {
  console.log('🧪 Starting SutramLan Unit Tests...\n');

  // Test 1: LanSecurity PIN hashing & verification
  console.log('1. Testing PIN hashing & verification...');
  const secret = '7890';
  const { hash, salt } = LanSecurity.hashSecret(secret);
  assert(hash && salt, 'Hash and salt should be generated');
  assert(LanSecurity.verifySecret('7890', hash, salt) === true, 'Correct PIN should verify');
  assert(LanSecurity.verifySecret('0000', hash, salt) === false, 'Wrong PIN should fail');
  console.log('   ✓ PIN hashing and timing-safe verification passed.');

  // Test 2: Challenge-Response replay protection
  console.log('2. Testing Challenge-Response handshake...');
  const challenge = LanSecurity.createChallenge();
  const solution = LanSecurity.solveChallenge(hash, challenge);
  const isValid = LanSecurity.verifyChallengeSolution(solution, hash, challenge);
  assert(isValid === true, 'Challenge solution should be valid');
  const isInvalid = LanSecurity.verifyChallengeSolution('bad_response', hash, challenge);
  assert(isInvalid === false, 'Invalid solution should be rejected');
  console.log('   ✓ Challenge-Response handshake passed.');

  // Test 3: Token issuance & verification
  console.log('3. Testing signed session tokens...');
  const sec = new LanSecurity({ serverSecret: 'super-secret-key-for-test' });
  const token = sec.issueToken({ projectId: 'test_proj', role: 'editor' });
  assert(typeof token === 'string' && token.split('.').length === 3, 'Valid JWT structure expected');
  const payload = sec.verifyToken(token);
  assert(payload && payload.projectId === 'test_proj' && payload.role === 'editor', 'Payload must match');
  assert(sec.verifyToken(token + 'tampered') === null, 'Tampered token must be rejected');
  console.log('   ✓ Session token generation & verification passed.');

  // Test 4: SutramLan full instance setup & auth challenge
  console.log('4. Testing SutramLan project registration & challenge flow...');
  const lan = new SutramLan({
    nodeName: 'Test-Machine',
    httpPort: 3300,
    broadcastPort: 45678 // Unique test port
  });

  lan.shareProject({
    id: 'my_company_db',
    name: 'My Company ERP',
    authType: 'pin',
    pin: '1234'
  });

  const nodeInfo = lan.getNodeInfo();
  assert(nodeInfo.nodeName === 'Test-Machine', 'Node name should match');
  assert(nodeInfo.sharedProjects.length === 1, 'Should have 1 shared project');
  assert(nodeInfo.sharedProjects[0].id === 'my_company_db', 'Project ID should match');

  // Request challenge
  const chal = lan.createAuthChallenge('my_company_db');
  assert(chal.challenge && chal.authType === 'pin', 'Challenge should be created');

  // Solve challenge
  const cred = lan.projectCredentials.get('my_company_db');
  const clientSolution = LanSecurity.solveChallenge(cred.hash, chal.challenge);
  const authRes = lan.verifyAuthResponse(chal.challenge, clientSolution);
  assert(authRes.success === true && authRes.token, 'Auth response should succeed with token');

  const verifiedSession = lan.verifyToken(authRes.token);
  assert(verifiedSession.projectId === 'my_company_db', 'Session project ID should match');
  console.log('   ✓ SutramLan challenge & project sharing passed.');

  console.log('\n🎉 ALL SUTRAM LAN TESTS PASSED SUCCESSFULLY!\n');
}

runTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
