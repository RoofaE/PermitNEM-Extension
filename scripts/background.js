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

  console.log('PermitFlow: Crawling WorkDrive folder...');
  const allFiles = await crawlWorkDrive(folderId);
  console.log(`PermitFlow: Found ${allFiles.length} files total`);

  const { attachFiles, billFile } = await selectAndDownloadFiles(allFiles);
  const extractedData = await extractWithClaude(attachFiles, billFile, apiKey);
  const finalData = mergeData(extractedData, dealData, attachFiles);

  const { files: fileData, ...dataWithoutFiles } = finalData;
  await chrome.storage.local.set({ permitData: dataWithoutFiles });
  await chrome.storage.local.set({ permitFiles: fileData });

  return { success: true };
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

async function crawlWorkDrive(folderId, depth = 0) {
  if (depth > 5) return [];
  const items = await workdriveList(folderId);
  const files = [];

  for (const item of items) {
    const attrs = item.attributes || {};
    const isFolder = attrs.type === 'folder';
    const name = (attrs.name || '').toLowerCase();

    if (isFolder) {
      const subFiles = await crawlWorkDrive(item.id, depth + 1);
      files.push(...subFiles);
    } else {
      const ext = name.split('.').pop();
      if (['pdf', 'png', 'jpg', 'jpeg'].includes(ext)) {
        files.push({
          id:          item.id,
          name:        attrs.name || '',
          ext:         ext,
          downloadUrl: attrs.download_url || '',
          permalink:   attrs.permalink    || '',
          mimeType:    ext === 'pdf' ? 'application/pdf' : (ext === 'png' ? 'image/png' : 'image/jpeg'),
        });
        console.log(`PermitFlow: Found file — ${attrs.name}`);
      }
    }
  }

  return files;
}

async function selectAndDownloadFiles(allFiles) {
  const scored = allFiles.map(f => ({ ...f, score: scoreFile(f.name) }));

  const sldFile  = findBestMatch(scored, 'sld');
  const siteFile = findBestMatch(scored, 'siteplan');
  const specFile = findBestMatch(scored, 'spec');
  const billFile = findBestMatch(scored, 'bill');

  console.log('PermitFlow: SLD →',       sldFile?.name);
  console.log('PermitFlow: Site plan →',  siteFile?.name);
  console.log('PermitFlow: Spec sheet →', specFile?.name);
  console.log('PermitFlow: Bill →',       billFile?.name);

  const attachFiles = {};

  if (sldFile) {
    attachFiles.sld = await downloadFile(sldFile.downloadUrl, sldFile.permalink, sldFile.id);
    attachFiles.sld.filename = sldFile.name;
  }
  if (siteFile) {
    attachFiles.siteplan = await downloadFile(siteFile.downloadUrl, siteFile.permalink, siteFile.id);
    attachFiles.siteplan.filename = siteFile.name;
  }
  if (specFile) {
    attachFiles.bill = await downloadFile(specFile.downloadUrl, specFile.permalink, specFile.id);
    attachFiles.bill.filename = specFile.name;
  }

  let billForAI = null;
  if (billFile) {
    billForAI = await downloadFile(billFile.downloadUrl, billFile.permalink, billFile.id);
    billForAI.filename = billFile.name;
  }

  return { attachFiles, billFile: billForAI };
}

function scoreFile(name) {
  const n = name.toLowerCase();
  return {
    sld:      scoreSLD(n),
    siteplan: scoreSitePlan(n),
    spec:     scoreSpec(n),
    bill:     scoreBill(n),
  };
}

function scoreSLD(n) {
  let s = 0;
  if (n.includes('sld'))          s += 10;
  if (n.includes('single line'))  s += 10;
  if (n.includes('electrical'))   s += 5;
  if (n.includes('diagram'))      s += 3;
  if (n.endsWith('.pdf'))         s += 2;
  return s;
}

function scoreSitePlan(n) {
  let s = 0;
  if (n.includes('site'))         s += 10;
  if (n.includes('plan'))         s += 5;
  if (n.includes('aerial'))       s += 5;
  if (n.includes('map'))          s += 3;
  if (n.endsWith('.png') || n.endsWith('.jpg') || n.endsWith('.jpeg')) s += 2;
  return s;
}

function scoreSpec(n) {
  let s = 0;
  if (n.includes('spec'))         s += 10;
  if (n.includes('datasheet'))    s += 8;
  if (n.includes('data sheet'))   s += 8;
  if (n.includes('ds3'))          s += 8;
  if (n.includes('ja solar') || n.includes('jasolar')) s += 6;
  if (n.includes('krack') || n.includes('k-rack'))     s += 6;
  if (n.includes('module'))       s += 5;
  if (n.includes('inverter'))     s += 5;
  if (n.includes('panel'))        s += 3;
  if (n.endsWith('.pdf'))         s += 2;
  return s;
}

function scoreBill(n) {
  let s = 0;
  if (n.includes('bill'))         s += 10;
  if (n.includes('invoice'))      s += 8;
  if (n.includes('saskpower'))    s += 8;
  if (n.includes('payment'))      s += 6;
  if (n.includes('utility'))      s += 5;
  if (n.includes('power'))        s += 4;
  if (n.includes('img'))          s += 1;
  if (n.endsWith('.png') || n.endsWith('.jpg') || n.endsWith('.jpeg')) s += 1;
  return s;
}

function findBestMatch(scored, type) {
  const candidates = scored
    .filter(f => f.score[type] > 0)
    .sort((a, b) => b.score[type] - a.score[type]);
  return candidates[0] || null;
}

async function downloadFile(downloadUrl, permalink, fileId) {
  const token = await getZohoToken();

  // Try download_url with browser session
  if (downloadUrl) {
    try {
      const resp = await fetch(downloadUrl, { credentials: 'include' });
      if (resp.ok) {
        const ct = resp.headers.get('content-type') || '';
        if (!ct.includes('text/html')) {
          return await blobToResult(resp);
        }
      }
    } catch(e) {}
  }

  // Try WorkDrive API with token
  if (fileId && token) {
    try {
      const resp = await fetch(
        `https://www.zohoapis.com/workdrive/api/v1/files/${fileId}/content`,
        { headers: { 'Authorization': `Zoho-oauthtoken ${token}` } }
      );
      if (resp.ok) {
        return await blobToResult(resp);
      }
    } catch(e) {}
  }

  // Try permalink
  if (permalink) {
    try {
      const resp = await fetch(`${permalink}?download=true`, { credentials: 'include' });
      if (resp.ok) {
        const ct = resp.headers.get('content-type') || '';
        if (!ct.includes('text/html')) {
          return await blobToResult(resp);
        }
      }
    } catch(e) {}
  }

  throw new Error(`Could not download file`);
}

async function blobToResult(resp) {
  const blob = await resp.blob();
  const arrayBuf = await blob.arrayBuffer();
  const uint8 = new Uint8Array(arrayBuf);
  const rawB64 = uint8ToBase64(uint8);
  const mimeType = (blob.type && blob.type !== 'application/octet-stream') ? blob.type : null;
  const compressedB64 = await compressImageIfNeeded(rawB64, blob.type);
  return { b64: compressedB64, filename: '', mimeType: mimeType || blob.type };
}

function uint8ToBase64(uint8) {
  let binary = '';
  for (let i = 0; i < uint8.length; i++) binary += String.fromCharCode(uint8[i]);
  return btoa(binary);
}

async function compressImageIfNeeded(b64, mimeType) {
  if (!mimeType || mimeType.includes('pdf')) return b64;
  if (!mimeType.startsWith('image/')) return b64;
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      let width = img.width, height = img.height;
      const maxDim = 1500;
      if (width > maxDim || height > maxDim) {
        const ratio = Math.min(maxDim / width, maxDim / height);
        width  = Math.round(width * ratio);
        height = Math.round(height * ratio);
      }
      canvas.width = width; canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', 0.7).split(',')[1]);
    };
    img.onerror = () => resolve(b64);
    img.src = `data:${mimeType};base64,${b64}`;
  });
}

function getMediaType(filename, mimeType) {
  if (mimeType && mimeType !== 'application/octet-stream') return mimeType;
  const ext = (filename || '').split('.').pop().toLowerCase();
  if (ext === 'pdf')                   return 'application/pdf';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'png')                   return 'image/png';
  return 'image/jpeg';
}

async function extractWithClaude(attachFiles, billFile, apiKey) {
  const content = [];

  if (billFile) {
    const mt = getMediaType(billFile.filename, billFile.mimeType);
    if (mt === 'application/pdf') {
      content.push({ type: 'document', source: { type: 'base64', media_type: mt, data: billFile.b64 } });
    } else {
      content.push({ type: 'image', source: { type: 'base64', media_type: mt, data: billFile.b64 } });
    }
  }

  if (attachFiles.sld) {
    const mt = getMediaType(attachFiles.sld.filename, attachFiles.sld.mimeType);
    if (mt === 'application/pdf') {
      content.push({ type: 'document', source: { type: 'base64', media_type: mt, data: attachFiles.sld.b64 } });
    } else {
      content.push({ type: 'image', source: { type: 'base64', media_type: mt, data: attachFiles.sld.b64 } });
    }
  }

  if (attachFiles.siteplan) {
    const mt = getMediaType(attachFiles.siteplan.filename, attachFiles.siteplan.mimeType);
    if (mt === 'application/pdf') {
      content.push({ type: 'document', source: { type: 'base64', media_type: mt, data: attachFiles.siteplan.b64 } });
    } else {
      content.push({ type: 'image', source: { type: 'base64', media_type: mt, data: attachFiles.siteplan.b64 } });
    }
  }

  content.push({ type: 'text', text: `You are analyzing solar installation documents for a SaskPower NEM permit application.
Extract ALL fields from these documents. Return ONLY raw JSON, nothing else.

{
  "num_modules": "6",
  "num_ds3h_inverters": "3",
  "total_inverter_kw": "3.150",
  "account_number": "50000240738",
  "house_number": "350",
  "street_name": "Zeman Cres",
  "city": "Saskatoon",
  "postal_code": "S7K 7W9",
  "person1_first": "GASTON",
  "person1_middle_initial": "H",
  "person1_last": "COTE",
  "person1_mailing_address": "350 Zeman Cres",
  "person1_city": "Saskatoon",
  "has_second_person": true,
  "person2_first": "MICHELLE",
  "person2_middle_initial": "M",
  "person2_last": "COTE",
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
- Bill names are LAST, FIRST format — reverse them. "COTE, GASTON H." means first=GASTON, last=COTE, middle=H
- person1_first must be ONLY the first name, never the full name
- person1_last must be ONLY the last name, never the full name
- The FIRST person listed on the bill is person1, SECOND is person2
- Mailing address is at the BOTTOM of the bill
- Account number: strip all spaces
- Count DS3-H micro inverters from SLD
- total_inverter_kw = DS3-H count * 1.050, 3 decimal places
- location_type: city for street address, rural for farm/acreage, firstnation for reserve
- For rural: fill qtr_lsd, section, township, range, meridian
- For firstnation: fill first_nation_name, reserve_name` });

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      messages:   [{ role: 'user', content }]
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

function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

function mergeData(extracted, dealData, files) {
  const isoDate = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
  const month = String(isoDate.getMonth() + 1).padStart(2, '0');
  const day   = String(isoDate.getDate()).padStart(2, '0');
  const year  = isoDate.getFullYear();

  const fileData = {};
  if (files.sld)      fileData.sld      = { b64: files.sld.b64,      filename: files.sld.filename,      mimeType: files.sld.mimeType };
  if (files.siteplan) fileData.siteplan = { b64: files.siteplan.b64, filename: files.siteplan.filename, mimeType: files.siteplan.mimeType };
  if (files.bill)     fileData.bill     = { b64: files.bill.b64,     filename: files.bill.filename,     mimeType: files.bill.mimeType };

  return {
    ...extracted,
    person1_first:           capitalize(extracted.person1_first  || ''),
    person1_last:            capitalize(extracted.person1_last   || ''),
    person1_middle_initial:  (extracted.person1_middle_initial || '').toUpperCase(),
    person1_email:           dealData.email  || '',
    person1_phone:           dealData.phone  || '',
    person1_mailing_address: extracted.person1_mailing_address || `${extracted.house_number} ${extracted.street_name}`,
    person1_city:            extracted.person1_city || extracted.city || dealData.city || '',
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