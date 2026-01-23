# Testing Guide

## Integration Test Suite

The Gruff project includes an automated integration test suite (`test-runner.js`) that verifies the API functionality against a local development server.

### Running Tests

```bash
npm test
```

This will:
1. Delete and recreate the local database
2. Run migrations
3. Start the Wrangler dev server
4. Execute all test functions
5. Stop the server and report results

### Test Suite Features

- **Automatic database reset**: Ensures clean state for each test run
- **Color-coded output**: Easy to scan for passes/failures
- **Detailed assertions**: Clear success/failure messages
- **Graceful cleanup**: Stops dev server even if tests fail
- **Exit codes**: Returns 0 on success, 1 on failure (CI-friendly)

### Test Structure

The test runner includes helper functions for common operations:

#### Making API Requests

```javascript
const response = await makeRequest('GET', '/api/endpoint', optionalBody);
// Returns: { status, ok, data, headers }
```

#### Assertions

```javascript
// Simple boolean assertion
assert(condition, 'Description of what should be true');

// Equality assertion
assertEquals(actual, expected, 'Description of expected value');
```

### Adding New Tests

As you implement features, add corresponding test functions to `test-runner.js`:

1. Create a new async function in the "Test Suites" section:

```javascript
async function testMyNewFeature() {
  logTest('My New Feature Description');

  const response = await makeRequest('POST', '/api/my-endpoint', {
    key: 'value'
  });

  assertEquals(response.status, 201, 'Should return 201 Created');
  assert(response.data.id, 'Should return created resource with ID');
  // Add more assertions...
}
```

2. Add your test function to the `tests` array in `runTests()`:

```javascript
const tests = [
  testHealthEndpoint,
  testRootEndpoint,
  testApiEndpoint,
  test404NotFound,
  testMyNewFeature,  // <-- Add here
];
```

### Test Organization

As the test suite grows, consider organizing tests by feature area:

```javascript
// Example organization
const tests = [
  // Infrastructure
  testHealthEndpoint,
  testRootEndpoint,

  // Authentication
  testUserRegistration,
  testUserLogin,
  testJwtRefresh,

  // Entities
  testCreateEntity,
  testReadEntity,
  testUpdateEntity,
  testDeleteEntity,

  // Links
  testCreateLink,
  testGraphTraversal,
  // etc.
];
```

### Best Practices

1. **Test Isolation**: Each test should be independent and not rely on state from previous tests

2. **Clear Assertions**: Use descriptive messages that explain what's being tested

3. **Test Data**: Create and clean up test data as needed. The database is reset before each run, but within a single run, tests share the same database state

4. **Error Handling**: Tests that expect errors should catch them and verify the error response

5. **Comprehensive Coverage**: Test both success and failure cases

### Example Test Patterns

#### Testing CRUD Operations

```javascript
async function testEntityLifecycle() {
  logTest('Entity CRUD Lifecycle');

  // Create
  const createRes = await makeRequest('POST', '/api/entities', {
    type_id: 'some-type',
    properties: { name: 'Test' }
  });
  assertEquals(createRes.status, 201, 'Should create entity');
  const entityId = createRes.data.id;

  // Read
  const readRes = await makeRequest('GET', `/api/entities/${entityId}`);
  assertEquals(readRes.status, 200, 'Should read entity');
  assertEquals(readRes.data.id, entityId, 'Should return same entity');

  // Update
  const updateRes = await makeRequest('PUT', `/api/entities/${entityId}`, {
    properties: { name: 'Updated' }
  });
  assertEquals(updateRes.status, 200, 'Should update entity');

  // Delete
  const deleteRes = await makeRequest('DELETE', `/api/entities/${entityId}`);
  assertEquals(deleteRes.status, 200, 'Should delete entity');
}
```

#### Testing Authentication

```javascript
async function testAuthFlow() {
  logTest('Authentication Flow');

  // Register
  const registerRes = await makeRequest('POST', '/api/auth/register', {
    email: 'test@example.com',
    password: 'password123'
  });
  assertEquals(registerRes.status, 201, 'Should register user');

  // Login
  const loginRes = await makeRequest('POST', '/api/auth/login', {
    email: 'test@example.com',
    password: 'password123'
  });
  assertEquals(loginRes.status, 200, 'Should login successfully');
  const token = loginRes.data.token;
  assert(token, 'Should return JWT token');

  // Use token for authenticated request
  const meRes = await fetch(`${DEV_SERVER_URL}/api/auth/me`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  assertEquals(meRes.status, 200, 'Should access protected endpoint');
}
```

#### Testing Error Cases

```javascript
async function testValidation() {
  logTest('Input Validation');

  // Missing required field
  const res1 = await makeRequest('POST', '/api/entities', {
    // missing type_id
    properties: {}
  });
  assertEquals(res1.status, 400, 'Should reject invalid input');
  assert(res1.data.error, 'Should return error message');

  // Invalid format
  const res2 = await makeRequest('POST', '/api/entities', {
    type_id: 'invalid-uuid-format',
    properties: {}
  });
  assertEquals(res2.status, 400, 'Should reject invalid UUID');
}
```

### Continuous Integration

The test suite is designed to work in CI environments:

```yaml
# Example GitHub Actions workflow
- name: Run tests
  run: npm test
```

The test runner will:
- Exit with code 0 if all tests pass
- Exit with code 1 if any test fails
- Properly clean up the dev server on exit

### Troubleshooting

**Server won't start**: Check if port 8787 is already in use

**Tests hang**: Increase `STARTUP_TIMEOUT` or `TEST_TIMEOUT` in test-runner.js

**Database errors**: Manually delete `.wrangler/state` and run `npm run migrate:local`

**Module errors**: Ensure `"type": "module"` is set in package.json
