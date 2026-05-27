import express, { Request, Response } from 'express';

const app = express();
app.use(express.json());

const PORT = 3010;
const MOCK_SESSION_ID = 'eyJhbGciOiJIUzI1NiJ9.MOCK_SESSION.MOCK_SIGNATURE';
const MOCK_PROPOSAL_NUM = '1120008703919';
const MOCK_POLICY_NUM   = '13092104';

// Helper to build 25 mock tokens
function mockTokens() {
  return Array.from({ length: 25 }, (_, i) => ({
    tokenKey:   String(i + 1),
    tokenValue: `mock_token_value_${i + 1}_${Date.now()}`,
  }));
}

// ── Logging middleware ──────────────────────────────────────────────────────
app.use((req, _res, next) => {
  console.log(`[MOCK] ${req.method} ${req.path}`);
  next();
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. generatePartnerToken
// ═══════════════════════════════════════════════════════════════════════════
app.post('/relinterfacerestful/religare/secure/restful/generatePartnerToken', (_req: Request, res: Response) => {
  res.json({
    responseData: { status: '1', message: 'Success' },
    partnerTokenGeneratorInputIO: {
      partnerId:        'MOCK_PARTNER',
      securityKey:      '',
      sessionId:        MOCK_SESSION_ID,
      listOfToken:      mockTokens(),
      loginSessionTime: new Date().toISOString(),
      errorLists:       [],
      listErrorListList: [],
    },
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. getAllQuestions
// ═══════════════════════════════════════════════════════════════════════════
app.post('/relinterfacerestful/religare/secure/restful/getAllQuestions', (req: Request, res: Response) => {
  const pid = req.body?.baseProductId || '12001003';
  res.json({
    responseData: { status: '1', message: 'Success' },
    questionDOList: [
      { questionSetCd: 'yesNoExist',      questionCd: 'pedYesNo', questionText: 'Does any person to be insured have any pre-existing diseases?', questionType: 'yesno' },
      { questionSetCd: 'HEDCFLEAFONE',    questionCd: 'H102',     questionText: 'Cancer', questionType: 'yesno' },
      { questionSetCd: 'HEDCFLEAFTWO',    questionCd: 'H103',     questionText: 'Cardiovascular / Heart Disease', questionType: 'yesno' },
      { questionSetCd: 'HEDCFLEAFTHREE',  questionCd: 'H104',     questionText: 'Hypertension / High Blood Pressure', questionType: 'yesno' },
      { questionSetCd: 'HEDCFLEAFFOUR',   questionCd: 'H105',     questionText: 'Respiratory disease / Lung disease', questionType: 'yesno' },
      { questionSetCd: 'HEDCFLEAFFIVE',   questionCd: 'H106',     questionText: 'Endocrine system disorder (Pituitary / Parathyroid / Adrenal)', questionType: 'yesno' },
      { questionSetCd: 'HEDCFLEAFSIX',    questionCd: 'H107',     questionText: 'Diabetes Mellitus type 1 or Diabetes on insulin', questionType: 'yesno' },
      { questionSetCd: 'HEDCFLEAFSEVEN',  questionCd: 'H108',     questionText: 'Neuromuscular / Nervous system disorder', questionType: 'yesno' },
      { questionSetCd: 'HEDCFLEAFEIGHT',  questionCd: 'H109',     questionText: 'Chronic Pancreatitis / Chronic Liver disease', questionType: 'yesno' },
      { questionSetCd: 'HEDCFLEAFNINE',   questionCd: 'H110',     questionText: 'Chronic Kidney Disease', questionType: 'yesno' },
      { questionSetCd: 'HEDCFLEAFTEN',    questionCd: 'H111',     questionText: 'Blood / Immunity disorders', questionType: 'yesno' },
      { questionSetCd: 'HEDCFLEAFELEVEN', questionCd: 'H112',     questionText: 'Smoked, consumed alcohol, or used recreational drugs?', questionType: 'yesno' },
      { questionSetCd: 'HEDCFLEAFTWELVE', questionCd: 'H113',     questionText: 'Any other disease / health condition not mentioned above?', questionType: 'yesno' },
      { questionSetCd: 'HEDCFLEAFTHIRTEEN', questionCd: 'H114',   questionText: 'Hospitalised or prolonged treatment / surgery in last 3 years?', questionType: 'yesno' },
      { questionSetCd: 'HEDCFLEAFFOURTEEN', questionCd: 'H115',   questionText: 'Consulted doctor / taken medication / investigations recommended?', questionType: 'yesno' },
      { questionSetCd: 'CFLEAFFIFTEEN',   questionCd: 'AddInfo',  questionText: 'Additional Information (if any answer above is YES)', questionType: 'text' },
    ].filter(() => true),
    baseProductId: pid,
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. createPolicy
// ═══════════════════════════════════════════════════════════════════════════
app.post('/relinterfacerestful/religare/secure/restful/createPolicy', (req: Request, res: Response) => {
  const policy = req.body?.intPolicyDataIO?.policy || {};
  const primaryMember = policy.partyDOList?.find((p: any) => p.roleCd === 'PRIMARY') || {};
  const premium = computeMockPremium(policy.sumInsured, policy.coverType, policy.partyDOList?.length);

  res.json({
    responseData: { status: '1', message: 'Success' },
    intPolicyDataIO: {
      policy: {
        proposalNum: MOCK_PROPOSAL_NUM,
        policyNum:   MOCK_POLICY_NUM,
        premium,
        coverType:   policy.coverType,
        sumInsured:  policy.sumInsured,
        partyDOList: policy.partyDOList || [],
        csrfToken:   primaryMember.guid || 'MOCK-GUID-1234',
        errorLists:  [],
        listErrorListList: [],
      },
    },
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. getPolicyStatusV2
// ═══════════════════════════════════════════════════════════════════════════
app.post('/relinterfacerestful/religare/secure/restful/getPolicyStatusV2', (req: Request, res: Response) => {
  const proposalNum = req.body?.intGetPolicyStatusIO?.proposalNum || MOCK_PROPOSAL_NUM;
  const statuses = ['Pending Application Entry', 'Pending Underwriting', 'INFORCE'];
  const status   = statuses[Math.floor(Math.random() * statuses.length)];

  res.json({
    responseData: { status: '1', message: 'Success' },
    intGetPolicyStatusIO: {
      proposalNum,
      policyNum:                  MOCK_POLICY_NUM,
      policyCommencementDt:       '2026-06-01',
      policyMaturityDt:           '2027-05-31',
      applicationDate:            new Date().toISOString().split('T')[0],
      inforceDate:                status === 'INFORCE' ? new Date().toISOString().split('T')[0] : '',
      policyStatus:               status,
      policyPremium:              12500.00,
      parentAgentId:              '20008325',
      mobileNumber:               '9999999999',
      policyCommencementTimestamp:'10:00:00',
      transactionId:              ['MOCK_TXN_' + Date.now()],
      errorLists:                 [],
      listErrorListList:          [],
    },
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. getPolicyPDFV2
// ═══════════════════════════════════════════════════════════════════════════
app.post('/relinterfacerestful/religare/secure/restful/getPolicyPDFV2', (req: Request, res: Response) => {
  const policyNum = req.body?.intFaveoGetPolicyPDFIO?.policyNum || MOCK_POLICY_NUM;
  // Minimal valid PDF in base64
  const mockPdfBase64 = buildMockPdfBase64(policyNum);

  res.json({
    responseData: { status: '1', message: 'Success' },
    intFaveoGetPolicyPDFIO: {
      policyNum,
      pdfBase64: mockPdfBase64,
      errorLists: [],
    },
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Payment gateway (HTML redirect)
// ═══════════════════════════════════════════════════════════════════════════
app.post('/portalui/PortalPaymentV2.run', (req: Request, res: Response) => {
  const { proposalNum, returnURL, source } = req.body;
  const callbackUrl = `${returnURL}?PNO=${MOCK_POLICY_NUM}&TXNREFNO=MOCK_TXN_${Date.now()}&UWC=INFORCE&ERRFLG=&ERRMSG=&receiptNum=MOCK_RCPT_001`;
  res.send(`<!DOCTYPE html><html><body>
    <h2>Mock CHI Payment Gateway</h2>
    <p>Proposal: <strong>${proposalNum}</strong></p>
    <p>Source: ${source}</p>
    <p><strong>Test Cards:</strong> 5123456789012346 | CVV: 123 | Exp: 05/2027 | OTP: 123456</p>
    <p><strong>Test UPI:</strong> anything@payu</p>
    <button onclick="window.location='${callbackUrl}'">✅ Simulate Successful Payment</button>
    &nbsp;
    <button onclick="window.location='${returnURL}?ERRFLG=E&ERRMSG=Payment+Failed'">❌ Simulate Failed Payment</button>
  </body></html>`);
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. Abacus Quotation Token (abacus.careinsurance.com mock)
// ═══════════════════════════════════════════════════════════════════════════
app.post('/religare_api/api/web/v1/auth/access-token', (_req: Request, res: Response) => {
  res.json({
    status: true,
    responseCode: 200,
    responseMsg: 'OK',
    data: { token: 'MOCK_ABACUS_TOKEN_' + Date.now() },
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. Abacus Quotation
// ═══════════════════════════════════════════════════════════════════════════
app.post('/religare_api/api/web/v1/abacus/partner', (req: Request, res: Response) => {
  const pf = req.body?.postedField || {};
  const members   = Number(pf.field_1  || 2);
  const si        = Number(pf.field_11 || 5);
  const basePrem  = si * 1200 * members;
  const gst       = Math.round(basePrem * 0.18);
  const totalPrem = basePrem + gst;

  res.json({
    status: true,
    responseCode: 200,
    responseMsg: 'OK',
    data: {
      abacusData: {
        abacusId:   req.body?.abacusId || 'MOCK_ABACUS_ID',
        title:      'Care Enhance',
        buyNow:     totalPrem,
        serviceTax: '18',
      },
      inputFields: [
        { id: 1,  label: 'Total Members',        fieldName: 'field_1',  fieldType: 'dropdown', dataValues: [1,2,3,4,5,6],                selectedValue: String(pf.field_1  || '2'),        isVisible: true,  isRequired: false },
        { id: 9,  label: 'Cover Type',           fieldName: 'field_9',  fieldType: 'dropdown', dataValues: ['Individual','Floater'],      selectedValue: String(pf.field_9  || 'Floater'),  isVisible: true,  isRequired: false },
        { id: 3,  label: 'Age of Eldest Member', fieldName: 'field_3',  fieldType: 'dropdown', dataValues: ['18-25 Years','26-30 Years','31-35 Years','36-40 Years','41-45 Years','46-50 Years','51-55 Years','56-60 Years'], selectedValue: String(pf.field_3 || '36 to 40 Years'), isVisible: true, isRequired: false },
        { id: 11, label: 'Sum Insured (Lakhs)',  fieldName: 'field_11', fieldType: 'dropdown', dataValues: [3,4,5,7,10,15,20,25],        selectedValue: String(pf.field_11 || '5'),        isVisible: true,  isRequired: false },
        { id: 4,  label: 'Policy Term',          fieldName: 'field_4',  fieldType: 'dropdown', dataValues: ['1 Year','2 Years','3 Years'], selectedValue: String(pf.field_4 || '1 Year'),    isVisible: true,  isRequired: false },
      ],
      outputFields: [
        { id: 8, label: 'Total Premium (incl. GST)', fieldName: 'field_8', fieldType: 'text', dataValues: [], selectedValue: String(totalPrem), isVisible: true, isRequired: false },
        { id: 99, label: 'Base Premium', fieldName: 'field_base', fieldType: 'text', dataValues: [], selectedValue: String(basePrem), isVisible: true, isRequired: false },
        { id: 100, label: 'GST (18%)',   fieldName: 'field_gst',  fieldType: 'text', dataValues: [], selectedValue: String(gst),       isVisible: true, isRequired: false },
      ],
    },
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. Document service (ix-uat.careinsurance.com mock)
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/auth/login', (_req: Request, res: Response) => {
  res.json({ status: true, data: { token: 'MOCK_DOC_JWT_' + Date.now() } });
});

app.post('/api/docservice/v1/upload', (req: Request, res: Response) => {
  const assetId        = 'mock-asset-' + Math.random().toString(36).slice(2, 10);
  const uniqueRefrenceId = Buffer.from('mock|' + Date.now()).toString('base64');
  res.json({
    responseData: { status: '1', message: 'Success' },
    assetId,
    uniqueRefrenceId,
    documentName: 'uploaded_document.pdf',
    url: `https://mock-s3.example.com/${assetId}`,
  });
});

app.post('/api/docservice/v1/verifydocument', (_req: Request, res: Response) => {
  res.json({ status: true, data: { verified: true } });
});

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════
function computeMockPremium(si: string, coverType: string, memberCount = 1): number {
  const siNum    = Number(si) || 500000;
  const baseRate = 0.025;
  const floaterMultiplier = coverType === 'FAMILYFLOATER' ? 1.4 : 1.0;
  const premium  = siNum * baseRate * floaterMultiplier * memberCount;
  return Math.round(premium * 1.18); // include GST
}

function buildMockPdfBase64(policyNum: string): string {
  // Minimal valid single-page PDF as base64
  const pdfContent = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 200>>
stream
BT /F1 16 Tf 50 720 Td (CARE HEALTH INSURANCE) Tj
0 -30 Td /F1 12 Tf (Policy Schedule - MOCK) Tj
0 -20 Td (Policy Number: ${policyNum}) Tj
0 -20 Td (Status: INFORCE [MOCK]) Tj
0 -20 Td (This is a mock PDF for UAT testing.) Tj
ET
endstream
endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
xref
0 6
0000000000 65535 f
0000000009 00000 n
0000000058 00000 n
0000000115 00000 n
0000000274 00000 n
0000000525 00000 n
trailer<</Size 6/Root 1 0 R>>
startxref
600
%%EOF`;
  return Buffer.from(pdfContent).toString('base64');
}

// ═══════════════════════════════════════════════════════════════════════════
// Start
// ═══════════════════════════════════════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`\n🎭 CHI Mock Server running on http://localhost:${PORT}`);
  console.log(`   All CHI UAT endpoints are mocked — no credentials needed\n`);
  console.log('   Endpoints:');
  console.log(`   POST /relinterfacerestful/.../generatePartnerToken`);
  console.log(`   POST /relinterfacerestful/.../getAllQuestions`);
  console.log(`   POST /relinterfacerestful/.../createPolicy`);
  console.log(`   POST /relinterfacerestful/.../getPolicyStatusV2`);
  console.log(`   POST /relinterfacerestful/.../getPolicyPDFV2`);
  console.log(`   POST /portalui/PortalPaymentV2.run`);
  console.log(`   POST /religare_api/.../auth/access-token  (Abacus)`);
  console.log(`   POST /religare_api/.../abacus/partner     (Quotation)`);
  console.log(`   POST /api/auth/login                      (Doc service)`);
  console.log(`   POST /api/docservice/v1/upload            (Doc service)\n`);
});
