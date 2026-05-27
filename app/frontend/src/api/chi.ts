import axios from 'axios';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || 'http://localhost:3001',
  headers: { 'Content-Type': 'application/json' },
});

export const chiApi = {
  // Products
  getProducts: () => api.get('/api/policy/products'),

  // Auth
  getAuthStatus: () => api.get('/api/auth/status'),
  refreshTokenPool: () => api.post('/api/auth/refresh'),

  // Health Questions
  getQuestions: (productCode: string) => api.get(`/api/questions/${productCode}`),

  // Quotation (Enhance only)
  getQuotation: (postedField: Record<string, string | number>) =>
    api.post('/api/quotation', { postedField }),

  // Document upload
  uploadDocument: (file: File, documentType = 'OVD_KYC') => {
    const form = new FormData();
    form.append('file', file);
    form.append('documentType', documentType);
    return api.post('/api/documents/upload', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
  },

  // Policy
  createPolicy: (productCode: string, payload: object) =>
    api.post(`/api/policy/create/${productCode}`, payload),

  getPolicyStatus: (proposalNum: string) =>
    api.get(`/api/policy/status/${proposalNum}`),

  getPolicyPDF: (policyNum: string) =>
    api.get(`/api/policy/pdf/${policyNum}`),

  getPaymentForm: (proposalNum: string, csrfToken: string, returnUrl: string) =>
    api.post('/api/policy/payment', { proposalNum, csrfToken, returnUrl }, { responseType: 'text' }),
};
