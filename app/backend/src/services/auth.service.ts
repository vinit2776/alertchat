import axios from 'axios';
import { config } from '../config/env';
import { buildTokenId } from '../utils/crypto';
import {
  GeneratePartnerTokenRequest,
  GeneratePartnerTokenResponse,
  TokenEntry,
} from '../types/chi.types';

interface TokenPool {
  sessionId: string;
  tokens: TokenEntry[];
  expiresAt: Date;
}

// Static headers sent on every policy API call
export function staticHeaders() {
  return {
    'Content-Type': 'application/json',
    appId:         config.chi.appId,
    signature:     config.chi.signature,
    timestamp:     config.chi.timestamp,
    applicationCD: 'PARTNERAPP',
  };
}

// Full headers for createPolicy / getPolicyStatusV2 / getPolicyPDFV2
export function policyHeaders(sessionId: string, token: TokenEntry, includeAgentId = false) {
  return {
    ...staticHeaders(),
    sessionId,
    tokenId: buildTokenId(token.tokenKey, token.tokenValue),
    ...(includeAgentId ? { agentId: config.chi.baseAgentId } : {}),
  };
}

class AuthService {
  private pool: TokenPool | null = null;
  private quotationToken: string | null = null;

  // ── Partner Token (policy APIs) ─────────────────────────────────────────────

  async getSessionAndToken(): Promise<{ sessionId: string; token: TokenEntry }> {
    if (!this.pool || this.pool.tokens.length === 0 || new Date() >= this.pool.expiresAt) {
      await this.refreshPool();
    }
    const token = this.pool!.tokens.shift()!;
    return { sessionId: this.pool!.sessionId, token };
  }

  private async refreshPool(): Promise<void> {
    const body: GeneratePartnerTokenRequest = {
      partnerTokenGeneratorInputIO: {
        partnerId:   config.chi.partnerId,
        securityKey: config.chi.securityKey,
      },
    };

    // Correct endpoint: /relinterfacerestful/religare/secure/restful/generatePartnerToken
    const { data } = await axios.post<GeneratePartnerTokenResponse>(
      `${config.chi.baseUrl}${config.chi.restPath}/generatePartnerToken`,
      body,
      { headers: staticHeaders() }
    );

    if (data.responseData.status !== '1') {
      throw new Error(`Token generation failed: ${data.responseData.message}`);
    }

    const io = data.partnerTokenGeneratorInputIO;
    // Sessions are valid for 15 minutes per CHI docs; refresh at 12 min
    const expiresAt = new Date(Date.now() + 12 * 60 * 1000);

    this.pool = {
      sessionId: io.sessionId,
      tokens: [...io.listOfToken],
      expiresAt,
    };

    console.log(`[Auth] Pool refreshed — ${this.pool.tokens.length} tokens, expires ${expiresAt.toISOString()}`);
  }

  poolStatus() {
    if (!this.pool) return { active: false, tokensRemaining: 0, expiresAt: null };
    return {
      active: true,
      tokensRemaining: this.pool.tokens.length,
      expiresAt: this.pool.expiresAt,
      sessionId: this.pool.sessionId,
    };
  }

  // ── Quotation Token (Care Enhance / Abacus) ────────────────────────────────

  async getQuotationToken(): Promise<string> {
    if (this.quotationToken) return this.quotationToken;

    // Endpoint: https://abacus.careinsurance.com/religare_api/api/web/v1/auth/access-token?formattype=json
    const { data } = await axios.post<{ status: boolean; responseMsg: string; data: { token: string } }>(
      `${config.chi.abacusBaseUrl}/religare_api/api/web/v1/auth/access-token?formattype=json`,
      { api_key: config.chi.abacusApiKey, auth_secret: config.chi.abacusSecret },
      { headers: { 'Content-Type': 'application/json' } }
    );

    if (!data.status) {
      throw new Error(`Quotation token failed: ${data.responseMsg}`);
    }

    this.quotationToken = data.data.token;
    return this.quotationToken;
  }

  clearQuotationToken() {
    this.quotationToken = null;
  }
}

export const authService = new AuthService();
