# Deployment Guide

The .github/workflows/ci.yml file contains everything you need. Here's what it does and what you need to configure:

## What the CI/CD Pipeline Does

On Every Push/PR:

1. Code Quality Checks

- Runs ESLint
- Checks Prettier formatting
- TypeScript type checking

2. Automated Testing

- Unit tests with coverage reporting
- Integration tests

On Pull Requests:

3. Preview Deployment

- Deploys to a preview environment (--env preview)
- Posts a comment on the PR with the preview URL
- Updates with each new commit

On Push to Main:

4. Production Deployment

- Runs D1 database migrations on production database
- Deploys the Worker to production
- Creates a deployment record in GitHub

## Step 1: Get Your Cloudflare API Token

1. Go to https://dash.cloudflare.com/profile/api-tokens
2. Click "Create Token"
3. Use the "Edit Cloudflare Workers" template (or create custom with these  
   permissions):

- Account > Workers Scripts > Edit
- Account > Workers KV Storage > Edit
- Account > D1 > Edit
- Account > Account Settings > Read

4. Set Account Resources to include your account
5. Click "Continue to summary" → "Create Token"
6. Copy the token (you'll only see it once!)

## Step 2: Get Your Cloudflare Account ID

1. Go to https://dash.cloudflare.com/
2. Select any Workers & Pages project (or go to the Workers dashboard)
3. Your Account ID is shown on the right sidebar

## Step 3: Add Secrets to GitHub

1. Go to your GitHub repository
2. Click Settings → Secrets and variables → Actions
3. Click "New repository secret"
4. Add these two secrets:

Secret 1:

- Name: CLOUDFLARE_API_TOKEN
- Value: (paste the API token from Step 1)

Secret 2:

- Name: CLOUDFLARE_ACCOUNT_ID
- Value: (your Cloudflare Account ID from Step 2)

## Step 4: Set Up Cloudflare Resources

You need to create the production and preview resources in Cloudflare. Run  
these commands locally:

### Login to Cloudflare

```
npx wrangler login
```

### Create production D1 database

```
npx wrangler d1 create gruff-db
```

### Create production KV namespace

```
npx wrangler kv namespace create KV
```

### Create preview D1 database

```
npx wrangler d1 create gruff-db-preview
```

### Create preview KV namespace

```
npx wrangler kv namespace create KV_PREVIEW
```

Each command will output an ID. Copy those IDs.

## Step 5: Update wrangler.toml

Update the `wrangler.toml` file with the actual resource IDs you just created:

For production (around line 109):

```
database_id = "your-actual-production-database-id"
```

For production KV (around line 114):

```
id = "your-actual-production-kv-id"
```

For preview (around line 73):

```
database_id = "your-actual-preview-database-id"
```

For preview KV (around line 78):

```
id = "your-actual-preview-kv-id"
```

## Step 6: Set Production Secrets

Set the JWT secret for production (this is used to sign auth tokens):

### Production JWT secret

```
npx wrangler secret put JWT_SECRET --env production
```

When prompted, enter a strong random secret (e.g., generate with: `openssl rand -base64 32`)

### Preview JWT secret

```
npx wrangler secret put JWT_SECRET --env preview
```

Enter a different secret for preview

## Step 7: Commit and Push!

```
git add wrangler.toml
git commit -m "Configure production and preview deployments"
git push origin main
```

What Happens Next

1. On push to main:

- Runs all tests
- Runs D1 migrations on production database
- Deploys to production Cloudflare Workers
- You can see the deployment URL in the GitHub Actions output

2. On opening a PR:

- Runs all tests
- Deploys to preview environment
- Posts a comment with preview URL on the PR

3. On each PR commit:

- Updates the preview deployment automatically

Viewing Deployments

- GitHub Actions: Go to your repo → Actions tab to see all workflow runs
- Cloudflare Dashboard: https://dash.cloudflare.com → Workers & Pages to see
  deployed Workers
- Production URL: Will be https://gruff.your-account.workers.dev (or custom
  domain if you set one up)

Optional: Custom Domain

To use a custom domain instead of \*.workers.dev:

1. Add a domain to Cloudflare (if you haven't already)
2. In Cloudflare dashboard → Workers & Pages → select your Worker
3. Go to Settings → Domains & Routes
4. Add a custom domain or route

That's it! The CI/CD pipeline is already fully configured and ready to go  
once you add those secrets.

When you run `npm run dev` locally, Wrangler uses the default (top-level) configuration. When GitHub Actions deploys with --env production, it uses the production configuration.
