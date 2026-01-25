/**
 * Google OAuth2 Service
 *
 * Handles Google OAuth2 authentication flow including:
 * - Authorization URL generation with PKCE
 * - Authorization code exchange for tokens
 * - User profile fetching from Google
 */

// Google OAuth2 endpoints
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';

// OAuth2 scopes for user profile access
const DEFAULT_SCOPES = ['openid', 'email', 'profile'];

/**
 * Google OAuth configuration
 */
export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/**
 * Google user profile from userinfo endpoint
 */
export interface GoogleUserProfile {
  id: string;
  email: string;
  verified_email: boolean;
  name?: string;
  given_name?: string;
  family_name?: string;
  picture?: string;
}

/**
 * Token response from Google token endpoint
 */
export interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
  token_type: string;
  id_token?: string;
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
 * Generate a random string for PKCE code verifier or state
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
 * Generate PKCE code challenge from verifier
 * Uses SHA-256 hash of the verifier
 */
async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hash = await crypto.subtle.digest('SHA-256', data);

  // Base64 URL encode the hash
  const hashArray = new Uint8Array(hash);
  let binary = '';
  for (let i = 0; i < hashArray.length; i++) {
    binary += String.fromCharCode(hashArray[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/**
 * Generate OAuth state parameter
 * Returns both the state string and the full state object
 */
export function generateOAuthState(): { state: string; stateData: OAuthState } {
  const codeVerifier = generateRandomString(43);
  const stateData: OAuthState = {
    nonce: generateRandomString(16),
    timestamp: Date.now(),
    codeVerifier,
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
 * Build Google OAuth2 authorization URL
 *
 * @param config - OAuth configuration
 * @param state - State parameter for CSRF protection
 * @param codeChallenge - PKCE code challenge
 * @param scopes - OAuth scopes to request
 * @returns Authorization URL
 */
export async function buildAuthorizationUrl(
  config: GoogleOAuthConfig,
  state: string,
  codeVerifier: string,
  scopes: string[] = DEFAULT_SCOPES
): Promise<string> {
  const codeChallenge = await generateCodeChallenge(codeVerifier);

  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: scopes.join(' '),
    state: state,
    access_type: 'offline', // Request refresh token
    prompt: 'consent', // Force consent to get refresh token
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

/**
 * Exchange authorization code for tokens
 *
 * @param config - OAuth configuration
 * @param code - Authorization code from Google
 * @param codeVerifier - PKCE code verifier
 * @returns Token response from Google
 */
export async function exchangeCodeForTokens(
  config: GoogleOAuthConfig,
  code: string,
  codeVerifier: string
): Promise<GoogleTokenResponse> {
  const params = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code: code,
    grant_type: 'authorization_code',
    redirect_uri: config.redirectUri,
    code_verifier: codeVerifier,
  });

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const errorData = await response.text();
    throw new Error(`Failed to exchange code for tokens: ${response.status} ${errorData}`);
  }

  return (await response.json()) as GoogleTokenResponse;
}

/**
 * Fetch user profile from Google
 *
 * @param accessToken - Google access token
 * @returns User profile from Google
 */
export async function fetchUserProfile(accessToken: string): Promise<GoogleUserProfile> {
  const response = await fetch(GOOGLE_USERINFO_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const errorData = await response.text();
    throw new Error(`Failed to fetch user profile: ${response.status} ${errorData}`);
  }

  return (await response.json()) as GoogleUserProfile;
}

/**
 * Validate that the Google profile has required fields
 */
export function validateGoogleProfile(profile: GoogleUserProfile): {
  valid: boolean;
  error?: string;
} {
  if (!profile.id) {
    return { valid: false, error: 'Google profile missing user ID' };
  }

  if (!profile.email) {
    return { valid: false, error: 'Google profile missing email' };
  }

  if (!profile.verified_email) {
    return { valid: false, error: 'Google email is not verified' };
  }

  return { valid: true };
}
