// ─── Auth ─────────────────────────────────────────────────────────────────────

export interface GeneratePartnerTokenRequest {
  partnerTokenGeneratorInputIO: {
    partnerId: string;
    securityKey: string;
  };
}

export interface TokenEntry {
  tokenKey: string;
  tokenValue: string;
}

export interface GeneratePartnerTokenResponse {
  responseData: ResponseData;
  partnerTokenGeneratorInputIO: {
    partnerId: string;
    securityKey: string;
    sessionId: string;
    listOfToken: TokenEntry[];
    loginSessionTime: string;
    errorLists: ErrorEntry[];
    listErrorListList: ErrorEntry[];
  };
}

export interface QuotationTokenRequest {
  api_key: string;
  auth_secret: string;
}

export interface QuotationTokenResponse {
  status: boolean;
  responseCode: number;
  responseMsg: string;
  data: {
    token: string;
  };
}

// ─── Common ───────────────────────────────────────────────────────────────────

export interface ResponseData {
  status: string;
  message: string;
}

export interface ErrorEntry {
  errorCode?: string;
  errorMessage?: string;
}

// ─── Address ──────────────────────────────────────────────────────────────────

export interface AddressDO {
  addressTypeCd: 'PERMANENT' | 'COMMUNICATION';
  addressLine1Lang1: string;
  addressLine2Lang1?: string;
  areaCd: string;
  cityCd: string;
  stateCd: string;
  pinCode: string;
  countryCd: string;
}

// ─── Party ────────────────────────────────────────────────────────────────────

export type RoleCode = 'PRIMARY' | 'PROPOSER';
export type GenderCode = 'MALE' | 'FEMALE';
export type TitleCode = 'MR' | 'MRS' | 'MS' | 'DR';
export type RelationCode = 'SELF' | 'SPSE' | 'SONM' | 'DAUG' | 'FATM' | 'MOTM' | 'GMOT' | string;

export interface PartyQuestionDO {
  questionSetCd: string;
  questionCd: string;
  response: string;
}

export interface PartyContactDO {
  contactTypeCd: 'MOBILE' | 'LANDLINE';
  contactNum: string;
  stdCode: string;
}

export interface PartyEmailDO {
  emailTypeCd: 'PERSONAL' | 'OFFICIAL';
  emailAddress: string;
}

export interface PartyIdentityDO {
  identityTypeCd: 'PAN' | 'AADHAR' | 'PASSPORT' | 'VOTERID' | 'DRIVING';
  identityNum: string;
}

export interface PartyBankDetails {
  bankAccountNumber: string;
  bankIFSCCode: string;
}

export interface PartyDO {
  guid: string;
  firstName: string;
  lastName: string;
  roleCd: RoleCode;
  birthDt: string;
  genderCd: GenderCode;
  titleCd: TitleCode;
  relationCd: RelationCode;
  ckyc?: string;
  ckycNumber?: string;
  ovdkyc?: string;
  partyBankDetails?: PartyBankDetails;
  partyAddressDOList: AddressDO[];
  partyContactDOList: PartyContactDO[];
  partyEmailDOList: PartyEmailDO[];
  partyIdentityDOList: PartyIdentityDO[];
  partyQuestionDOList: PartyQuestionDO[];
}

// ─── Nominee ──────────────────────────────────────────────────────────────────

export interface AppointeeDO {
  titleCd: TitleCode;
  firstName: string;
  lastName: string;
  relationshipWithNominee: string;
  birthDt: string;
  genderCd: GenderCode;
  emailID?: string;
  stdCode?: string;
  contactNum?: string;
  appointeeAddressDO: AddressDO[];
}

export interface NomineeDetailsDO {
  firstName: string;
  lastName: string;
  birthDt: string;
  genderCd: GenderCode;
  age: string;
  titleCd: TitleCode;
  relationWithProposer: string;
  emailID?: string;
  stdCode?: string;
  contactNum?: string;
  bankAccountNumber?: string;
  bankIFSCCode?: string;
  bankMICR?: string;
  beneficiaryName?: string;
  claimPercentage: string;
  nomineeAddressDO: AddressDO[];
  appointeeDO?: AppointeeDO;
}

// ─── Document / KYC ───────────────────────────────────────────────────────────

export interface DocumentDetailDO {
  assetId: string;
  documentName: string;
  documentType: 'OVD_KYC' | string;
  uniqueRefrenceId: string;
}

export interface OvdDetails {
  ovdKyc: 'YES' | 'NO';
  addressPf: 'YES' | 'NO';
  idPf: 'YES' | 'NO';
  kycFl: 'YES' | 'NO';
  idPfType: string;
  addressPfType: string;
}

export interface DocumentDetails {
  documentDetailsDOList: DocumentDetailDO[];
  ovdDetails: OvdDetails;
}

// ─── Policy Additional Fields ─────────────────────────────────────────────────

export interface PolicyAdditionalFieldsDO {
  fieldAgree: string;
  fieldTc: string;
  fieldAlerts: string;
  field1: string;
}

// ─── Create Policy ────────────────────────────────────────────────────────────

export type CoverType = 'INDIVIDUAL' | 'FAMILYFLOATER';
export type BusinessType = 'NEWBUSINESS' | 'RENEWAL';

export interface PolicyPayload {
  documentDetails?: DocumentDetails;
  nomineeDetailsDO: NomineeDetailsDO[];
  baseAgentId: string;
  baseProductId: string;
  businessTypeCd: BusinessType;
  coverType: CoverType;
  policyAdditionalFieldsDOList: PolicyAdditionalFieldsDO[];
  partyDOList: PartyDO[];
  addOns?: string;
  sumInsured: string;
  term: string;
  isPremiumCalculation: 'YES' | 'NO';
}

export interface CreatePolicyRequest {
  intPolicyDataIO: {
    policy: PolicyPayload;
  };
}

export interface CreatePolicyResponse {
  responseData: ResponseData;
  intPolicyDataIO: {
    policy: {
      partyDOList: Partial<PartyDO>[];
      proposalNum?: string;
      policyNum?: string;
      premium?: number;
      errorLists: ErrorEntry[];
      listErrorListList: ErrorEntry[];
    };
  };
}

// ─── Policy Status ────────────────────────────────────────────────────────────

export interface GetPolicyStatusRequest {
  intGetPolicyStatusIO: {
    proposalNum: string;
  };
}

export interface GetPolicyStatusResponse {
  responseData: ResponseData;
  intGetPolicyStatusIO: {
    proposalNum: string;
    policyNum: string;
    policyCommencementDt: string;
    policyMaturityDt: string;
    applicationDate: string;
    inforceDate: string;
    policyStatus: string;
    policyPremium: number;
    parentAgentId: string;
    mobileNumber: string;
    policyCommencementTimestamp: string;
    transactionId: string[];
    errorLists: ErrorEntry[];
    listErrorListList: ErrorEntry[];
  };
}

// ─── Policy PDF ───────────────────────────────────────────────────────────────

export interface GetPolicyPDFRequest {
  intFaveoGetPolicyPDFIO: {
    policyNum: string;
    ltype: 'POLSCHD' | string;
  };
}

export interface GetPolicyPDFResponse {
  responseData: ResponseData;
  intFaveoGetPolicyPDFIO: {
    policyNum: string;
    pdfBase64?: string;
    pdfUrl?: string;
    errorLists: ErrorEntry[];
  };
}

// ─── Questions ────────────────────────────────────────────────────────────────

export interface QuestionDO {
  questionSetCd: string;
  questionCd: string;
  questionText: string;
  questionType: string;
  options?: string[];
}

export interface GetAllQuestionsResponse {
  responseData: ResponseData;
  questionDOList: QuestionDO[];
}

// ─── Quotation (Enhance) ──────────────────────────────────────────────────────

export interface QuotationRequest {
  partnerId: string;
  abacusId: string;
  postedField: Record<string, string | number>;
}

export interface QuotationFieldDef {
  id: number;
  label: string;
  fieldId: number;
  fieldName: string;
  tooltip: string;
  fieldType: 'dropdown' | 'text' | 'number';
  dataValues: (string | number)[];
  selectedValue: string;
  isVisible: boolean;
  isRequired: boolean;
}

export interface QuotationResponse {
  status: boolean;
  responseCode: number;
  responseMsg: string;
  data: {
    abacusData: {
      abacusId: string;
      title: string;
      buyNow: number;
      serviceTax: string;
    };
    inputFields: QuotationFieldDef[];
    outputFields?: QuotationFieldDef[];
  };
}

// ─── Document Upload ──────────────────────────────────────────────────────────

export interface DocumentUploadResponse {
  responseData: ResponseData;
  assetId: string;
  uniqueRefrenceId: string;
  documentName: string;
}

// ─── Products ─────────────────────────────────────────────────────────────────

export type ProductCode =
  | 'CARE'
  | 'CARE_FREEDOM'
  | 'CARE_SUPREME'
  | 'CARE_ENHANCE'
  | 'CARE_ADVANTAGE'
  | 'CARE_HEART'
  | 'ULTIMATE_CARE';

export const PRODUCT_META: Record<ProductCode, { name: string; productId: string; hasQuotation: boolean }> = {
  CARE:           { name: 'Care',           productId: '12001003', hasQuotation: false },
  CARE_FREEDOM:   { name: 'Care Freedom',   productId: '12001007', hasQuotation: false },
  CARE_SUPREME:   { name: 'Care Supreme',   productId: '12001005', hasQuotation: false },
  CARE_ENHANCE:   { name: 'Care Enhance',   productId: '12001009', hasQuotation: true  },
  CARE_ADVANTAGE: { name: 'Care Advantage', productId: '12001006', hasQuotation: false },
  CARE_HEART:     { name: 'Care Heart',     productId: '12001008', hasQuotation: false },
  ULTIMATE_CARE:  { name: 'Ultimate Care',  productId: '12001004', hasQuotation: false },
};
