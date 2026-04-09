'use strict';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'runPermit') {
    handleRunPermit(msg.dealData, msg.apiKey)
      .then(result => sendResponse(result))
      .catch(err  => sendResponse({ error: err.message }));
    return true;
  }
});

async function handleRunPermit(dealData, apiKey) {
  const workdriveUrl = dealData.workdriveUrl;
  if (!workdriveUrl) throw new Error('No WorkDrive URL found on this deal.');
  const folderId = extractFolderId(workdriveUrl);
  if (!folderId) throw new Error('Could not extract folder ID from WorkDrive URL.');
  const files = await fetchPermitFiles(folderId);
  const extractedData = await extractWithClaude(files, apiKey);
  const finalData = mergeData(extractedData, dealData, files);
  return { data: finalData };
}

function extractFolderId(url) {
  const m = url.match(/\/folder\/([a-zA-Z0-9]+)/);
  return m ? m[1] : null;
}

async function getZohoToken() {
  const { zohoToken } = await chrome.storage.local.get('zohoToken');
  return zohoToken || null;
}

async function workdriveList(folderId) {
  const token = await getZohoToken();
  if (!token) throw new Error('Not authenticated with Zoho. Click "Connect Zoho" in settings.');
  const resp = await fetch(
    `https://www.zohoapis.com/workdrive/api/v1/files/${folderId}/files`,
    { headers: { 'Authorization': `Zoho-oauthtoken ${token}` } }
  );
  if (!resp.ok) throw new Error(`WorkDrive API error: ${resp.status}`);
  const json = await resp.json();
  return json.data || [];
}

async function findSubfolder(parentId, name) {
  const items = await workdriveList(parentId);
  const found = items.find(i =>
    i.attributes?.name?.toLowerCase() === name.toLowerCase() &&
    i.attributes?.type === 'folder'
  );
  return found?.id || null;
}

async function getFirstFile(folderId) {
  const items = await workdriveList(folderId);
  const file = items.find(i => i.attributes?.type !== 'folder') || null;
  if (file) console.log('FILE FOUND:', JSON.stringify(file));
  return file;
}

async function downloadFile(downloadUrl, permalink) {
  // Try permalink with download flag
  if (permalink) {
    try {
      const dlUrl = permalink.includes('?') 
        ? `${permalink}&download=true` 
        : `${permalink}?download=true`;
      const resp = await fetch(dlUrl, { credentials: 'include' });
      if (resp.ok) {
        const ct = resp.headers.get('content-type') || '';
        // Make sure we got a file, not an HTML page
        if (!ct.includes('text/html')) {
          const blob = await resp.blob();
          const arrayBuf = await blob.arrayBuffer();
          const uint8 = new Uint8Array(arrayBuf);
          return { b64: uint8ToBase64(uint8), filename: '', mimeType: blob.type };
        }
      }
    } catch(e) {}
  }
  
  // Fallback to download_url with token
  const token = await getZohoToken();
  const resp = await fetch(downloadUrl, { 
    headers: { 'Authorization': `Zoho-oauthtoken ${token}` },
    credentials: 'include'
  });
  if (!resp.ok) throw new Error(`Failed to download file: ${resp.status}`);
  const blob = await resp.blob();
  const arrayBuf = await blob.arrayBuffer();
  const uint8 = new Uint8Array(arrayBuf);
  return { b64: uint8ToBase64(uint8), filename: '', mimeType: blob.type };
}

function uint8ToBase64(uint8) {
  let binary = '';
  for (let i = 0; i < uint8.length; i++) binary += String.fromCharCode(uint8[i]);
  return btoa(binary);
}

async function fetchPermitFiles(rootFolderId) {
  const files = {};
  const errors = [];

  try {
    const permId = await findSubfolder(rootFolderId, 'Permitting');
    if (permId) {
      const elecId = await findSubfolder(permId, 'Electrical');
      if (elecId) {
        const sldFile = await getFirstFile(elecId);
        if (sldFile) {
          files.sld = await downloadFile(sldFile.attributes?.download_url, sldFile.attributes?.permalink);
          files.sld.filename = sldFile.attributes?.name || 'sld.pdf';
        }
      }
      const permItems = await workdriveList(permId);
      const siteFile = permItems.find(i => {
        const name = (i.attributes?.name || '').toLowerCase();
        const type = i.attributes?.type;
        return type !== 'folder' && (name.endsWith('.png') || name.endsWith('.jpg') || name.endsWith('.jpeg') || name.endsWith('.pdf'));
      });
      if (siteFile) {
        files.siteplan = await downloadFile(siteFile.attributes?.download_url, siteFile.attributes?.permalink);
        files.siteplan.filename = siteFile.attributes?.name || 'siteplan.png';
      }
    }
  } catch (e) {
    errors.push('Permitting folder: ' + e.message);
  }

  try {
    const picsId = await findSubfolder(rootFolderId, 'Pics');
    if (picsId) {
      const billFoldId = await findSubfolder(picsId, 'Power Bill');
      if (billFoldId) {
        const billFile = await getFirstFile(billFoldId);
        if (billFile) {
          files.bill = await downloadFile(billFile.attributes?.download_url, billFile.attributes?.permalink);
          files.bill.filename = billFile.attributes?.name || 'bill.pdf';
        }
      }
    }
  } catch (e) {
    errors.push('Power Bill folder: ' + e.message);
  }

  const missing = ['sld', 'siteplan', 'bill'].filter(k => !files[k]);
  if (missing.length > 0) {
    throw new Error(`Could not find: ${missing.join(', ')}. Check WorkDrive folder structure.\n${errors.join('\n')}`);
  }

  return files;
}

function getMediaType(filename) {
  const ext = (filename || '').split('.').pop().toLowerCase();
  if (ext === 'pdf')               return 'application/pdf';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'png')               return 'image/png';
  if (ext === 'webp')              return 'image/webp';
  return 'image/png';
}

async function extractWithClaude(files, apiKey) {
  const content = [];

  for (const key of ['bill', 'sld', 'siteplan']) {
    const file = files[key];
    const mt = getMediaType(file.filename);
    if (mt === 'application/pdf') {
      content.push({ type: 'document', source: { type: 'base64', media_type: mt, data: file.b64 } });
    } else {
      const imageMt = (file.mimeType && file.mimeType !== 'application/octet-stream')
        ? file.mimeType
        : mt;
      content.push({ type: 'image', source: { type: 'base64', media_type: mt, data: file.b64 } });
    }
  }

  content.push({ type: 'text', text: `Extract fields from these solar permit documents. Return ONLY raw JSON.

{
  "num_modules": "6",
  "num_ds3h_inverters": "3",
  "total_inverter_kw": "3.150",
  "account_number": "50000240738",
  "house_number": "123",
  "street_name": "Example St",
  "city": "Saskatoon",
  "postal_code": "S7K 0A1",
  "person1_first": "JOHN",
  "person1_middle_initial": "A",
  "person1_last": "SMITH",
  "person1_mailing_address": "123 Example St",
  "person1_city": "Saskatoon",
  "has_second_person": true,
  "person2_first": "JANE",
  "person2_middle_initial": "B",
  "person2_last": "SMITH",
  "location_type": "city",
  "qtr_lsd": "",
  "section": "",
  "township": "",
  "range": "",
  "meridian": "",
  "first_nation_name": "",
  "reserve_name": ""
}

Rules:
- Bill names are LAST, FIRST - reverse them (SMITH, JOHN A means first=JOHN last=SMITH)
- Two people are often listed on the bill - extract both
- Mailing address is at BOTTOM of bill
- Count DS3-H inverters from SLD
- total_inverter_kw = count * 1.050 to 3 decimal places
- Account number: strip all spaces
- location_type: city / rural / firstnation
- has_second_person: true if second person found on bill, else false` });

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: 'claude-opus-4-5',
      max_tokens: 800,
      messages: [{ role: 'user', content }]
    })
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error?.message || `Claude API error: ${resp.status}`);
  }

  const json = await resp.json();
  const raw = json.content.map(b => b.text || '').join('').trim();
  const m = raw.match(/\{[\s\S]*\}/);
  return JSON.parse(m ? m[0] : raw);
}

function mergeData(extracted, dealData, files) {
  const isoDate = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
  const month = String(isoDate.getMonth() + 1).padStart(2, '0');
  const day = String(isoDate.getDate()).padStart(2, '0');
  const year = isoDate.getFullYear();

  const fileData = {
    sld:      { b64: files.sld.b64,      filename: files.sld.filename,      mimeType: files.sld.mimeType },
    siteplan: { b64: files.siteplan.b64, filename: files.siteplan.filename, mimeType: files.siteplan.mimeType },
    bill:     { b64: files.bill.b64,     filename: files.bill.filename,     mimeType: files.bill.mimeType }
  };

  return {
    ...extracted,
    person1_first:           dealData.firstName    || extracted.person1_first  || '',
    person1_last:            dealData.lastName     || extracted.person1_last   || '',
    person1_middle_initial:  '',
    person1_email:           dealData.email        || '',
    person1_phone:           dealData.phone        || '',
    person1_mailing_address: dealData.streetAddress || `${extracted.house_number} ${extracted.street_name}`,
    person1_city:            dealData.city         || extracted.city || '',
    person1_postal:          extracted.postal_code || '',
    has_second_person:       extracted.has_second_person || false,
    person2_first:           extracted.person2_first          || '',
    person2_middle_initial:  extracted.person2_middle_initial || '',
    person2_last:            extracted.person2_last           || '',
    interconnection_date:    `${month}/${day}/${year}`,
    comment: `Installation of ${extracted.num_modules}x620W and ${extracted.num_ds3h_inverters}xDS3-H microinverters with Kinetic Racking`,
    files: fileData
  };
}
