# Seed Data Documentation

This document describes the sample data provided for local development and testing.

## Usage

### Load Seed Data

To populate your local database with seed data:

```bash
npm run seed:local
```

### Full Database Setup

To run all migrations and load seed data in one command:

```bash
npm run db:setup:local
```

## Sample Data Overview

The seed data creates a small graph demonstrating the relationships between people, organizations, and projects.

### Test User

- **ID**: `test-user-001`
- **Email**: `test@example.com`
- **Display Name**: Test User
- **Provider**: local

### Entity Types

1. **Person** (`type-person`)
   - Properties: name, age, email

2. **Organization** (`type-organization`)
   - Properties: name, industry, founded

3. **Project** (`type-project`)
   - Properties: name, status, description

### Link Types

1. **WorksFor** (`type-works-for`)
   - Properties: role, start_date, end_date

2. **Manages** (`type-manages`)
   - Properties: since

3. **ContributesTo** (`type-contributes-to`)
   - Properties: role, hours_per_week

### Sample Entities

#### People

- **Alice Johnson** (`entity-alice`)
  - Age: 32
  - Email: alice@example.com

- **Bob Smith** (`entity-bob`)
  - Age: 28
  - Email: bob@example.com

- **Carol Williams** (`entity-carol`)
  - Age: 45
  - Email: carol@example.com

#### Organizations

- **Acme Corporation** (`entity-acme-corp`)
  - Industry: Technology
  - Founded: 2015

- **TechStart Inc** (`entity-techstart`)
  - Industry: Software
  - Founded: 2020

#### Projects

- **Project Alpha** (`entity-project-alpha`)
  - Status: active
  - Description: Revolutionary AI platform

- **Project Beta** (`entity-project-beta`)
  - Status: completed
  - Description: Mobile app development

### Sample Relationships

#### Employment

- Alice works for Acme Corporation as Senior Engineer (since 2020-01-15)
- Bob works for Acme Corporation as Software Developer (since 2021-06-01)
- Carol works for TechStart Inc as CTO (since 2020-03-01)

#### Management

- Alice manages Bob (since 2022-01-01)

#### Project Contributions

- Alice contributes to Project Alpha as Lead Developer (40 hours/week)
- Bob contributes to Project Alpha as Developer (40 hours/week)
- Carol contributes to Project Beta as Technical Advisor (10 hours/week)

## Graph Structure

```
Alice (Person)
  ├─ works-for → Acme Corp (Organization)
  ├─ manages → Bob (Person)
  └─ contributes-to → Project Alpha (Project)

Bob (Person)
  ├─ works-for → Acme Corp (Organization)
  └─ contributes-to → Project Alpha (Project)

Carol (Person)
  ├─ works-for → TechStart Inc (Organization)
  └─ contributes-to → Project Beta (Project)
```

## Using Seed Data in Tests

The seed data provides consistent test fixtures that can be referenced in integration tests:

```javascript
// Example: Querying Alice's data
const response = await makeRequest('GET', '/api/entities/entity-alice');

// Example: Finding all employees of Acme Corp
const response = await makeRequest('GET', '/api/entities/entity-acme-corp/inbound?type=type-works-for');

// Example: Finding Alice's direct reports
const response = await makeRequest('GET', '/api/entities/entity-alice/outbound?type=type-manages');
```

## Resetting Data

The test runner automatically resets the database before each test run. To manually reset:

```bash
# Delete the local database
rm -rf .wrangler/state

# Recreate with migrations and seed data
npm run db:setup:local
```

## Extending Seed Data

To add more seed data:

1. Edit `migrations/0004_seed_data.sql`
2. Add your INSERT statements following the existing patterns
3. Reload the seed data with `npm run seed:local`
4. Update this documentation to reflect the new data

## Notes

- All IDs in the seed data use descriptive names (e.g., `entity-alice`) for easy reference in tests
- Timestamps use `strftime('%s', 'now')` to generate current Unix timestamps
- The password hash for the test user is a placeholder and should not be used in production
- All entities and links are in version 1 with `is_latest=1` and `is_deleted=0`
