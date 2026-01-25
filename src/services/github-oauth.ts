/**
 * GitHub OAuth2 Service
 *
 * Handles GitHub OAuth2 authentication flow including:
 * - Authorization URL generation with PKCE
 * - Authorization code exchange for tokens
 * - User profile fetching from GitHub
 */

// GitHub OAuth2 endpoints
const GITHUB_AUTH_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_USER_URL = 'https://api.github.com/user';
const GITHUB_USER_EMAILS_URL = 'https://api.github.com/user/emails';

// OAuth2 scopes for user profile access
const DEFAULT_SCOPES = ['read:user', 'user:email'];

/**
 * GitHub OAuth configuration
 */
export interface GitHubOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/**
 * GitHub user profile from user endpoint
 */
export interface GitHubUserProfile {
  id: number;
  login: string;
  email: string | null;
  name: string | null;
  avatar_url: string | null;
}

/**
 * GitHub email object from emails endpoint
 */
export interface GitHubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
  visibility: string | null;
}

/**
 * Token response from GitHub token endpoint
 */
export interface GitHubTokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
}

/**
 * State parameter for OAuth2 flow
 * Used to prevent CSRF attacks
 */
export interface OAuthState {
  nonce: string;
  timestamp: number;
  codeVerifier?: string;
}

/**
 * Generate a random string for state
 * Uses cryptographically secure random values
 */
function generateRandomString(length: number = 43): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const randomValues = new Uint8Array(length);
  crypto.getRandomValues(randomValues);
  return Array.from(randomValues)
    .map(v => chars[v % chars.length])
    .join('');
}

/**
 * Generate OAuth state parameter
 * Returns both the state string and the full state object
 *
 * Note: GitHub does not support PKCE, so we don't include codeVerifier.
 * State is still used for CSRF protection.
 */
export function generateOAuthState(): { state: string; stateData: OAuthState } {
  const stateData: OAuthState = {
    nonce: generateRandomString(16),
    timestamp: Date.now(),
  };

  // Encode state as base64 for URL safety
  const state = btoa(JSON.stringify(stateData))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');

  return { state, stateData };
}

/**
 * Parse and validate OAuth state parameter
 */
export function parseOAuthState(state: string): OAuthState | null {
  try {
    // Decode base64 URL safe state
    const padded = state + '=='.substring(0, (4 - (state.length % 4)) % 4);
    const base64 = padded.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = atob(base64);
    const stateData = JSON.parse(decoded) as OAuthState;

    // Validate state has required fields
    if (!stateData.nonce || !stateData.timestamp) {
      return null;
    }

    // Check if state is expired (15 minutes max)
    const maxAge = 15 * 60 * 1000; // 15 minutes in milliseconds
    if (Date.now() - stateData.timestamp > maxAge) {
      return null;
    }

    return stateData;
  } catch {
    return null;
  }
}

/**
 * Build GitHub OAuth2 authorization URL
 *
 * @param config - OAuth configuration
 * @param state - State parameter for CSRF protection
 * @param scopes - OAuth scopes to request
 * @returns Authorization URL
 */
export function buildAuthorizationUrl(
  config: GitHubOAuthConfig,
  state: string,
  scopes: string[] = DEFAULT_SCOPES
): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: scopes.join(' '),
    state: state,
  });

  return `${GITHUB_AUTH_URL}?${params.toString()}`;
}

/**
 * Exchange authorization code for tokens
 *
 * @param config - OAuth configuration
 * @param code - Authorization code from GitHub
 * @returns Token response from GitHub
 */
export async function exchangeCodeForTokens(
  config: GitHubOAuthConfig,
  code: string
): Promise<GitHubTokenResponse> {
  const params = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code: code,
    redirect_uri: config.redirectUri,
  });

  const response = await fetch(GITHUB_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const errorData = await response.text();
    throw new Error(`Failed to exchange code for tokens: ${response.status} ${errorData}`);
  }

  const data = (await response.json()) as
    | GitHubTokenResponse
    | { error: string; error_description?: string };

  // GitHub returns error in JSON body with 200 status
  if ('error' in data) {
    throw new Error(`GitHub OAuth error: ${data.error} - ${data.error_description || ''}`);
  }

  return data as GitHubTokenResponse;
}

/**
 * Fetch user profile from GitHub
 *
 * @param accessToken - GitHub access token
 * @returns User profile from GitHub
 */
export async function fetchUserProfile(accessToken: string): Promise<GitHubUserProfile> {
  const response = await fetch(GITHUB_USER_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (!response.ok) {
    const errorData = await response.text();
    throw new Error(`Failed to fetch user profile: ${response.status} ${errorData}`);
  }

  return (await response.json()) as GitHubUserProfile;
}

/**
 * Fetch user's primary verified email from GitHub
 *
 * GitHub may not include email in the user profile if it's private.
 * This function fetches the user's emails and returns the primary verified one.
 *
 * @param accessToken - GitHub access token
 * @returns Primary verified email or null
 */
export async function fetchUserPrimaryEmail(accessToken: string): Promise<string | null> {
  const response = await fetch(GITHUB_USER_EMAILS_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (!response.ok) {
    // If we can't fetch emails, return null (will use profile email if available)
    return null;
  }

  const emails = (await response.json()) as GitHubEmail[];

  // Find primary verified email
  const primaryEmail = emails.find(e => e.primary && e.verified);
  if (primaryEmail) {
    return primaryEmail.email;
  }

  // Fallback to any verified email
  const verifiedEmail = emails.find(e => e.verified);
  if (verifiedEmail) {
    return verifiedEmail.email;
  }

  return null;
}

/**
 * Validate that the GitHub profile has required fields
 */
export function validateGitHubProfile(
  profile: GitHubUserProfile,
  email: string | null
): {
  valid: boolean;
  error?: string;
} {
  if (!profile.id) {
    return { valid: false, error: 'GitHub profile missing user ID' };
  }

  if (!email) {
    return { valid: false, error: 'Could not retrieve verified email from GitHub' };
  }

  return { valid: true };
}
