import { useState } from 'react';
import { chiApi } from '../api/chi';

const PRODUCTS = [
  { code: 'CARE',           name: 'Care',           productId: '12001003' },
  { code: 'CARE_FREEDOM',   name: 'Care Freedom',   productId: '12001007' },
  { code: 'CARE_SUPREME',   name: 'Care Supreme',   productId: '12001005' },
  { code: 'CARE_ENHANCE',   name: 'Care Enhance',   productId: '12001009' },
  { code: 'CARE_ADVANTAGE', name: 'Care Advantage', productId: '12001006' },
  { code: 'CARE_HEART',     name: 'Care Heart',     productId: '12001008' },
  { code: 'ULTIMATE_CARE',  name: 'Ultimate Care',  productId: '12001004' },
];

const SAMPLE_PAYLOAD = {
  businessTypeCd: 'NEWBUSINESS',
  coverType: 'INDIVIDUAL',
  sumInsured: '500000',
  term: '1',
  isPremiumCalculation: 'YES',
  addOns: '',
  nomineeDetailsDO: [{
    firstName: 'Test',
    lastName: 'Nominee',
    birthDt: '01/01/1990',
    genderCd: 'MALE',
    age: '34',
    titleCd: 'MR',
    relationWithProposer: 'SPSE',
    claimPercentage: '100',
    nomineeAddressDO: [{
      addressTypeCd: 'PERMANENT',
      addressLine1Lang1: 'Test Address',
      areaCd: 'Mumbai',
      cityCd: 'Mumbai',
      stateCd: 'MAHARASHTRA',
      pinCode: '400001',
      countryCd: 'IND',
    }],
  }],
  policyAdditionalFieldsDOList: [{
    fieldAgree: 'YES',
    fieldTc: 'YES',
    fieldAlerts: 'YES',
    field1: 'Partner_NB_TestPartner',
  }],
  partyDOList: [{
    guid: `${Date.now()}-001`,
    firstName: 'Ramesh',
    lastName: 'Kumar',
    roleCd: 'PRIMARY',
    birthDt: '01/01/1985',
    genderCd: 'MALE',
    titleCd: 'MR',
    relationCd: 'SELF',
    ovdkyc: 'YES',
    partyAddressDOList: [
      { addressTypeCd: 'PERMANENT', addressLine1Lang1: '123 Test Street', areaCd: 'Andheri', cityCd: 'Mumbai', stateCd: 'MAHARASHTRA', pinCode: '400053', countryCd: 'IND' },
      { addressTypeCd: 'COMMUNICATION', addressLine1Lang1: '123 Test Street', areaCd: 'Andheri', cityCd: 'Mumbai', stateCd: 'MAHARASHTRA', pinCode: '400053', countryCd: 'IND' },
    ],
    partyContactDOList: [{ contactTypeCd: 'MOBILE', contactNum: '9999999999', stdCode: '+91' }],
    partyEmailDOList: [{ emailTypeCd: 'PERSONAL', emailAddress: 'test@example.com' }],
    partyIdentityDOList: [{ identityTypeCd: 'PAN', identityNum: 'ABCDE1234F' }],
    partyQuestionDOList: [{ questionSetCd: 'yesNoExist', questionCd: 'pedYesNo', response: 'NO' }],
  }, {
    guid: `${Date.now()}-001`,
    firstName: 'Ramesh',
    lastName: 'Kumar',
    roleCd: 'PROPOSER',
    birthDt: '01/01/1985',
    genderCd: 'MALE',
    titleCd: 'MR',
    relationCd: 'SELF',
    ovdkyc: 'YES',
    partyAddressDOList: [
      { addressTypeCd: 'PERMANENT', addressLine1Lang1: '123 Test Street', areaCd: 'Andheri', cityCd: 'Mumbai', stateCd: 'MAHARASHTRA', pinCode: '400053', countryCd: 'IND' },
      { addressTypeCd: 'COMMUNICATION', addressLine1Lang1: '123 Test Street', areaCd: 'Andheri', cityCd: 'Mumbai', stateCd: 'MAHARASHTRA', pinCode: '400053', countryCd: 'IND' },
    ],
    partyContactDOList: [{ contactTypeCd: 'MOBILE', contactNum: '9999999999', stdCode: '+91' }],
    partyEmailDOList: [{ emailTypeCd: 'PERSONAL', emailAddress: 'test@example.com' }],
    partyIdentityDOList: [{ identityTypeCd: 'PAN', identityNum: 'ABCDE1234F' }],
    partyQuestionDOList: [{ questionSetCd: 'yesNoExist', questionCd: 'pedYesNo', response: 'NO' }],
  }],
};

export default function PolicyPage() {
  const [product, setProduct] = useState('CARE');
  const [payload, setPayload] = useState(JSON.stringify(SAMPLE_PAYLOAD, null, 2));
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [proposalNum, setProposalNum] = useState('');

  const submit = async () => {
    setLoading(true);
    setError('');
    setResult(null);
    try {
      const parsed = JSON.parse(payload);
      const r = await chiApi.createPolicy(product, parsed);
      setResult(r.data);
      const pNum = r.data?.data?.intPolicyDataIO?.policy?.proposalNum;
      if (pNum) setProposalNum(pNum);
    } catch (e: any) {
      setError(e?.response?.data?.message || e?.message || 'Create policy failed');
    } finally { setLoading(false); }
  };

  return (
    <div>
      <div className="card">
        <div className="card-title">Create Policy</div>

        <div className="form-group">
          <label className="form-label">Product</label>
          <select className="form-select" value={product} onChange={e => setProduct(e.target.value)}>
            {PRODUCTS.map(p => <option key={p.code} value={p.code}>{p.name} ({p.productId})</option>)}
          </select>
        </div>

        <div className="form-group">
          <label className="form-label">Policy Payload (JSON)</label>
          <textarea
            className="form-input"
            style={{ fontFamily: 'monospace', fontSize: 12, minHeight: 400, resize: 'vertical' }}
            value={payload}
            onChange={e => setPayload(e.target.value)}
          />
        </div>

        {error && <div className="alert alert-error">{error}</div>}

        <button className="btn btn-primary" onClick={submit} disabled={loading}>
          {loading ? 'Submitting…' : 'Create Policy'}
        </button>
      </div>

      {result && (
        <div className="card">
          <div className="card-title">Response</div>
          {proposalNum && (
            <div className="alert alert-success">
              ✅ Proposal created: <strong>{proposalNum}</strong> — go to <em>Status</em> tab to check policy status.
            </div>
          )}
          <pre className="response-box">{JSON.stringify(result, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}
