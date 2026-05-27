import axios from 'axios';
import { config } from '../config/env';
import { authService } from './auth.service';
import { QuotationRequest, QuotationResponse } from '../types/chi.types';

export async function getQuotation(postedField: Record<string, string | number>): Promise<QuotationResponse> {
  const token = await authService.getQuotationToken();

  const body: QuotationRequest = {
    partnerId: config.chi.partnerId,
    abacusId: config.chi.abacusId,
    postedField,
  };

  try {
    // Endpoint: https://abacus.careinsurance.com/religare_api/api/web/v1/abacus/partner?formattype=json
    const { data } = await axios.post<QuotationResponse>(
      `${config.chi.abacusBaseUrl}/religare_api/api/web/v1/abacus/partner?formattype=json`,
      body,
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
      }
    );
    return data;
  } catch (err: any) {
    // Quotation token may have expired — clear and let caller retry
    if (err.response?.status === 401) {
      authService.clearQuotationToken();
    }
    throw err;
  }
}
