import PDFDocument from 'pdfkit';
import { readFileSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const font = readFileSync(new URL('../../assets/fonts/NotoSansDevanagari.ttf', import.meta.url));
const inr = value => `₹${new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value || 0))}`;
const address = value => {
  if (!value) return '—';
  if (typeof value === 'string') return value;
  const a = value.address && typeof value.address === 'object' ? value.address : value;
  return [a.line1 || a.street, a.line2, a.city || value.city, a.state || value.state, a.pinCode || a.pin_code || value.pinCode || value.pin_code].filter(Boolean).join(', ') || '—';
};
const safeImage = value => {
  const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(String(value || ''));
  if (!match || match[2].length > 2_500_000) return null;
  return Buffer.from(match[2], 'base64');
};
const publicAddress = ip => {
  if (isIP(ip) === 4) {
    const [a,b] = ip.split('.').map(Number);
    return !(a===0||a===10||a===127||a>=224||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&b===168)||(a===100&&b>=64&&b<=127)||(a===198&&(b===18||b===19)));
  }
  const normalized=ip.toLowerCase();
  if(normalized.startsWith('::ffff:'))return publicAddress(normalized.slice(7));
  if(normalized==='::'||normalized==='::1'||normalized.startsWith('fc')||normalized.startsWith('fd')||normalized.startsWith('fe8')||normalized.startsWith('fe9')||normalized.startsWith('fea')||normalized.startsWith('feb')||normalized.startsWith('ff')||normalized.startsWith('2001:db8:'))return false;
  const first=parseInt(normalized.split(':')[0]||'0',16);return first>=0x2000&&first<=0x3fff;
};
async function loadLogo(value){
  const embedded=safeImage(value);if(embedded)return embedded;
  try{
    const url=new URL(String(value));if(url.protocol!=='https:'||url.username||url.password)return null;
    const addresses=isIP(url.hostname)?[{address:url.hostname}]:await lookup(url.hostname,{all:true,verbatim:true});
    if(!addresses.length||addresses.some(entry=>!publicAddress(entry.address)))return null;
    const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(2500),headers:{accept:'image/png,image/jpeg'}});
    if(!response.ok||!/^image\/(png|jpeg)$/i.test(response.headers.get('content-type')||''))return null;
    const length=Number(response.headers.get('content-length')||0);if(length>2_000_000)return null;
    const bytes=Buffer.from(await response.arrayBuffer());return bytes.length<=2_000_000?bytes:null;
  }catch{return null;}
}

export function dealerQuotationPdf(data) {
  return new Promise(async (resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 38, compress: false, info: { Title: `Dealer Quotation ${data.quote.quotation_number}`, Author: 'Tiles Wala' } });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      doc.registerFont('Tiles', font).font('Tiles');
      const left = 38, right = doc.page.width - 38, width = right - left;
      const store = data.store;
      const logo = await loadLogo(store.logo_url);
      doc.fillColor('#245b49').rect(left, 34, width, 3).fill();
      let y = 48;
      if (logo) { try { doc.image(logo, left, y, { fit: [58, 48] }); } catch { /* Invalid configured logo; document remains usable. */ } }
      const textLeft = logo ? left + 70 : left;
      doc.fillColor('#17392f').fontSize(19).text(store.legal_name || store.name || 'TILES WALA', textLeft, y, { width: width - 70 });
      y = Math.max(doc.y, y + 23);
      doc.fillColor('#53655e').fontSize(8.5).text([address(store.address), [store.city, store.state, store.pin_code].filter(Boolean).join(', '), store.phone, store.email, store.gstin && `GSTIN: ${store.gstin}`].filter(Boolean).join(' · '), textLeft, y, { width: width - 70 });
      y = Math.max(doc.y, y + 15) + 14;
      doc.fillColor('#245b49').fontSize(15).text('TILES WALA — DEALER QUOTATION', left, y, { width, align: 'center' });
      y = doc.y + 12;
      doc.fillColor('#263b30').fontSize(9.5);
      const detailY = y;
      doc.text(`Quotation: ${data.quote.quotation_number}`, left, detailY, { width: width / 2 });
      doc.text(`Date: ${new Date(data.quote.created_at).toLocaleDateString('en-IN')}`, left + width / 2, detailY, { width: width / 2, align: 'right' });
      doc.text(`Expected delivery: ${data.quote.expected_delivery_date ? new Date(data.quote.expected_delivery_date).toLocaleDateString('en-IN') : '—'}`, left, detailY + 15, { width: width / 2 });
      doc.text(`Valid until: ${data.quote.valid_until ? new Date(data.quote.valid_until).toLocaleDateString('en-IN') : '—'}`, left + width / 2, detailY + 15, { width: width / 2, align: 'right' });
      y = detailY + 38;
      const dealer = data.dealer;
      doc.fillColor('#17392f').fontSize(10).text('Dealer', left, y);
      doc.fillColor('#263b30').fontSize(9).text([dealer.business_name, dealer.contact_name, dealer.mobile, dealer.email, `Billing: ${address(data.quote.billing_address_snapshot)}`].filter(Boolean).join('\n'), left, y + 14, { width: width / 2 - 12, lineGap: 2 });
      doc.fillColor('#17392f').fontSize(10).text('Delivery', left + width / 2, y);
      doc.fillColor('#263b30').fontSize(9).text([address(data.quote.delivery_address_snapshot), data.order.delivery_contact_name, data.order.delivery_contact_mobile, data.order.delivery_instructions && `Instructions: ${data.order.delivery_instructions}`].filter(Boolean).join('\n'), left + width / 2, y + 14, { width: width / 2 - 12, lineGap: 2 });
      y = Math.max(doc.y, y + 72) + 12;
      const cols = [left, left + width * .43, left + width * .55, left + width * .67, left + width * .82, right];
      const headings = ['Product', 'Qty', 'Unit', 'Dealer price', 'Line total'];
      doc.fillColor('#eaf2ed').rect(left, y, width, 24).fill();
      doc.fillColor('#17392f').fontSize(8.5);
      headings.forEach((h, i) => doc.text(h, cols[i] + 4, y + 7, { width: cols[i + 1] - cols[i] - 8, align: i > 0 ? 'right' : 'left' }));
      y += 24;
      for (const line of data.items) {
        const rowHeight = 38;
        doc.strokeColor('#d6e0da').moveTo(left, y + rowHeight).lineTo(right, y + rowHeight).stroke();
        const product = line.productName || line.product_name_snapshot || 'Product';
        const qty = line.quantity;
        const unit = line.unit || line.unit_snapshot || '';
        const price = line.dealerPrice ?? line.dealer_price_snapshot;
        const mrp = line.mrp ?? line.mrp_snapshot;
        const total = line.lineTotal ?? line.line_total ?? line.quotedLineTotal;
        const priceLabel = mrp !== null && mrp !== undefined && mrp !== '' ? `${inr(price)}\nMRP ${inr(mrp)}${Number(mrp)>Number(price)&&line.discountPercentage?` · ${Math.round(Number(line.discountPercentage))}% OFF`:''}` : inr(price);
        [product, `${qty}`, unit, priceLabel, inr(total)].forEach((v, i) => doc.fillColor('#263b30').fontSize(8).text(String(v), cols[i] + 4, y + 4, { width: cols[i + 1] - cols[i] - 8, align: i > 0 ? 'right' : 'left', ellipsis: true }));
        y += rowHeight;
        if (y > doc.page.height - 150) { doc.addPage(); y = 42; }
      }
      if (y > doc.page.height - 190) { doc.addPage(); y = 42; }
      y += 14;
      const summary = [
        ['Product subtotal', inr(data.quote.subtotal)],
        [`Transport${data.order.transport_mode ? ` · ${{SELF:'Self Pickup',TOTO:'Toto',THELA:'CNG Auto',PICKUP:'Pickup'}[data.order.transport_mode]||data.order.transport_mode}` : ''}`, inr(data.quote.transport_charge)],
        ...(Number(data.quote.discount_amount) ? [['Discount', `−${inr(data.quote.discount_amount)}`]] : []),
        ['Applicable tax', inr(data.quote.tax_amount)],
        ['Estimated grand total', inr(data.quote.grand_total)],
      ];
      for (const [label, value] of summary) {
        const bold = label === 'Estimated grand total';
        if (bold) doc.fillColor('#eaf2ed').rect(left + width * .55, y - 3, width * .45, 21).fill();
        doc.fillColor(bold ? '#17392f' : '#53655e').fontSize(bold ? 10 : 9).text(label, left + width * .58, y, { width: width * .21 });
        doc.fillColor('#17392f').fontSize(bold ? 10 : 9).text(value, left + width * .8, y, { width: width * .18, align: 'right' });
        y += bold ? 25 : 19;
      }
      y += 10;
      doc.fillColor('#263b30').fontSize(9).text(`Preferred payment method: ${data.order.payment_method === 'CASH_ON_DELIVERY' ? 'Cash on Delivery' : 'UPI'}`, left, y);
      y = doc.y + 10;
      doc.fillColor('#53655e').fontSize(8.5).text(`Terms and conditions: ${store.terms_and_conditions || 'This quotation is subject to stock confirmation and dealer acceptance.'}`, left, y, { width, lineGap: 2 });
      y = doc.y + 12;
      doc.fillColor('#a34f38').fontSize(10).text('This is a quotation/proforma document, not a tax invoice.', left, y, { width, align: 'center' });
      doc.end();
    } catch (error) { reject(error); }
  });
}
