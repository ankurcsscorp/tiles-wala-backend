const padSequence = (value, padding = 4) => String(value).padStart(Math.max(4, Number(padding) || 4), "0");

export function invoicePeriod(date, policy) {
  if (policy === "never") return { key: "all", label: "" };
  const [year, month] = String(date).slice(0, 10).split("-").map(Number);
  if (policy === "monthly") {
    const fyStart = month >= 4 ? year : year - 1;
    return { key: `${fyStart}-${String(month).padStart(2, "0")}`, label: `${String(fyStart).slice(-2)}-${String(month).padStart(2, "0")}` };
  }
  const fyStart = month >= 4 ? year : year - 1;
  return { key: `${fyStart}-${fyStart + 1}`, label: String(fyStart).slice(-2) };
}

export function invoicePeriodRange(date, policy) {
  if(policy==="never")return {start:null,end:null};
  const [year,month]=String(date).slice(0,10).split("-").map(Number);
  if(policy==="monthly")return {start:`${year}-${String(month).padStart(2,"0")}-01`,end:month===12?`${year+1}-01-01`:`${year}-${String(month+1).padStart(2,"0")}-01`};
  const startYear=month>=4?year:year-1;
  return {start:`${startYear}-04-01`,end:`${startYear+1}-04-01`};
}

/** Allocate a number on the caller's transaction; the sequence row lock serializes issuers. */
export async function allocateInvoiceNumber(db, { storeId, documentType, series, date, policy, padding = 4, initialNumber = 1 }) {
  const period = invoicePeriod(date, policy);
  await db.query(`INSERT INTO invoice_number_sequences(store_id,document_type,series,period_key,next_number)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(store_id,document_type,series,period_key) DO NOTHING`,
  [storeId, documentType, series, period.key, initialNumber]);
  const result = await db.query(`SELECT next_number FROM invoice_number_sequences
    WHERE store_id=$1 AND document_type=$2 AND series=$3 AND period_key=$4 FOR UPDATE`,
  [storeId, documentType, series, period.key]);
  const number = result.rows[0].next_number;
  await db.query(`UPDATE invoice_number_sequences SET next_number=next_number+1
    WHERE store_id=$1 AND document_type=$2 AND series=$3 AND period_key=$4`,
  [storeId, documentType, series, period.key]);
  return `${series}${period.label ? `${period.label}-` : "-"}${padSequence(number, padding)}`;
}

export function suggestInvoicePrefix(name = "") {
  const words = String(name).toUpperCase().match(/[A-Z0-9]+/g) || [];
  const initials = words.length > 1 && words[0].length === 1 && words[1].length === 1
    ? words.slice(0, 2).join("")
    : words.length > 1 ? words.map((word) => word[0]).join("") : (words[0] || "ST");
  return initials.slice(0, 4) || "ST";
}
