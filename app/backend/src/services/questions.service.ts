import axios from 'axios';
import { config } from '../config/env';
import { authService, policyHeaders } from './auth.service';
import { GetAllQuestionsResponse } from '../types/chi.types';

export async function getAllQuestions(productId: string): Promise<GetAllQuestionsResponse> {
  const { sessionId, token } = await authService.getSessionAndToken();

  const { data } = await axios.post<GetAllQuestionsResponse>(
    `${config.chi.baseUrl}${config.chi.restPath}/getAllQuestions`,
    { baseProductId: productId },
    { headers: policyHeaders(sessionId, token) }
  );

  return data;
}
