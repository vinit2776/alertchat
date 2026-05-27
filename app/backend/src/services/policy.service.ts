import axios from 'axios';
import { config } from '../config/env';
import { authService, policyHeaders } from './auth.service';
import {
  CreatePolicyRequest,
  CreatePolicyResponse,
  GetPolicyStatusRequest,
  GetPolicyStatusResponse,
  GetPolicyPDFRequest,
  GetPolicyPDFResponse,
  PolicyPayload,
  PRODUCT_META,
  ProductCode,
} from '../types/chi.types';

const BASE = () => `${config.chi.baseUrl}${config.chi.restPath}`;

export async function createPolicy(
  productCode: ProductCode,
  policyPayload: Omit<PolicyPayload, 'baseAgentId' | 'baseProductId'>
): Promise<CreatePolicyResponse> {
  const { sessionId, token } = await authService.getSessionAndToken();
  const meta = PRODUCT_META[productCode];

  const body: CreatePolicyRequest = {
    intPolicyDataIO: {
      policy: {
        ...policyPayload,
        baseAgentId: config.chi.baseAgentId,
        baseProductId: meta.productId,
      },
    },
  };

  const { data } = await axios.post<CreatePolicyResponse>(
    `${BASE()}/createPolicy`,
    body,
    { headers: policyHeaders(sessionId, token) }
  );

  return data;
}

export async function getPolicyStatus(proposalNum: string): Promise<GetPolicyStatusResponse> {
  const { sessionId, token } = await authService.getSessionAndToken();

  const body: GetPolicyStatusRequest = {
    intGetPolicyStatusIO: { proposalNum },
  };

  const { data } = await axios.post<GetPolicyStatusResponse>(
    `${BASE()}/getPolicyStatusV2`,
    body,
    { headers: policyHeaders(sessionId, token, true) }
  );

  return data;
}

export async function getPolicyPDF(policyNum: string, ltype: string = 'POLSCHD'): Promise<GetPolicyPDFResponse> {
  const { sessionId, token } = await authService.getSessionAndToken();

  const body: GetPolicyPDFRequest = {
    intFaveoGetPolicyPDFIO: { policyNum, ltype },
  };

  const { data } = await axios.post<GetPolicyPDFResponse>(
    `${BASE()}/getPolicyPDFV2`,
    body,
    { headers: policyHeaders(sessionId, token, true) }
  );

  return data;
}

export function buildPaymentFormHtml(proposalNum: string, csrfToken: string, returnUrl: string): string {
  return `<!DOCTYPE html>
<html>
<head><title>Redirecting to payment...</title></head>
<body>
<form id="PAYMENTFORM" name="PAYMENTFORM" method="post"
  action="${config.chi.baseUrl}/portalui/PortalPaymentV2.run">
  <input type="hidden" name="CSRF"        value="${csrfToken}" />
  <input type="hidden" name="proposalNum" value="${proposalNum}" />
  <input type="hidden" name="source"      value="PARTNER" />
  <input type="hidden" name="returnURL"   value="${returnUrl}" />
</form>
<script>document.getElementById('PAYMENTFORM').submit();</script>
</body>
</html>`;
}
