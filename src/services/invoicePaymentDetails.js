const fields = {accountName:160,accountNumber:34,bankName:160,branch:160,ifscCode:11,upiId:128};

export function normalizeInvoicePaymentDetails(value) {
  if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(key=>!Object.hasOwn(fields,key)))
    throw new Error('Enter valid invoice payment details.');
  const result={};
  for(const [key,limit] of Object.entries(fields)) {
    if(value[key]!==undefined && typeof value[key]!=='string')throw new Error('Payment details must be text.');
    const text=(value[key]||'').trim();
    if(text.length>limit)throw new Error(`${key} exceeds ${limit} characters.`);
    if(text)result[key]=key==='ifscCode'?text.toUpperCase():text;
  }
  if(['accountName','accountNumber','bankName','branch','ifscCode'].some(key=>result[key])) {
    if(!['accountName','accountNumber','bankName','ifscCode'].every(key=>result[key]))throw new Error('Bank details require account holder name, account number, bank name and IFSC code.');
    if(!/^\d{4,34}$/.test(result.accountNumber))throw new Error('Account number must contain 4 to 34 digits.');
    if(!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(result.ifscCode))throw new Error('Enter an 11-character IFSC code, for example ABCD0123456.');
  }
  if(result.upiId && !/^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9.-]*$/.test(result.upiId))throw new Error('Enter a valid UPI ID, for example shop@bank.');
  return result;
}
