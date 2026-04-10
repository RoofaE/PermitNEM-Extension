'use strict';

let dealData = null;

document.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('runBtn')?.addEventListener('click', runPermit);
  document.querySelector('.settings-link')?.addEventListener('click', toggleSettings);
  document.querySelector('.settings-save')?.addEventListener('click', saveSettings);
  document.getElementById('connectZohoBtn')?.addEventListener('click', connectZoho);

  const { apiKey, zohoClientId } = await chrome.storage.local.get(['apiKey', 'zohoClientId']);
  if (apiKey) document.getElementById('apiKeyInput').value = apiKey;
  if (zohoClientId) document.getElementById('clientIdInput').value = zohoClientId;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url || '';
  const isDealsPage = url.includes('crm.zoho.com') && url.includes('/tab/Potentials/');

  if (!isDealsPage) {
    show('notDeal');
    return;
  }

  try {
    const response = await chrome.tabs.sendMessage(tab.id, { action: 'getDealData' });
    if (!response || !response.success) { show('notDeal'); return; }

    dealData = response.data;
    if (!dealData.workdriveUrl) { show('noDrive'); return; }

    document.getElementById('clientName').textContent  = dealData.clientName || '—';
    document.getElementById('clientEmail').textContent = dealData.email || '';
    document.getElementById('clientPhone').textContent = dealData.phone || '';
    show('readyState');
  } catch (err) {
    show('notDeal');
  }
});

async function runPermit() {
  const { apiKey } = await chrome.storage.local.get('apiKey');
  if (!apiKey) {
    showStatus('error', 'No API key set. Click ⚙ Settings and add your Anthropic API key.');
    return;
  }
  if (!dealData?.workdriveUrl) {
    showStatus('error', 'No WorkDrive URL found on this deal.');
    return;
  }

  setLoading(true);
  showStatus('info', 'Crawling WorkDrive folder...');

  try {
    // Step 1: Background crawls and scores files
    const response = await chrome.runtime.sendMessage({
      action:   'runPermit',
      dealData: dealData,
      apiKey:   apiKey
    });

    if (response.error) {
      showStatus('error', response.error);
      setLoading(false);
      return;
    }

    const { filesMeta } = response;

    // Step 2: Download files in popup context (has browser cookies)
    showStatus('info', 'Downloading files...');
    const attachFiles = {};
    const billFile = await downloadFileInPopup(filesMeta.bill);

    const sldFile  = await downloadFileInPopup(filesMeta.sld);
    const siteFile = await downloadFileInPopup(filesMeta.siteplan);
    const specFile = await downloadFileInPopup(filesMeta.spec);

    if (sldFile)  { attachFiles.sld      = { ...sldFile,  filename: filesMeta.sld?.name  || 'sld.pdf' }; }
    if (siteFile) { attachFiles.siteplan = { ...siteFile, filename: filesMeta.siteplan?.name || 'siteplan.png' }; }
    if (specFile) { attachFiles.bill     = { ...specFile, filename: filesMeta.spec?.name  || 'specsheet.pdf' }; }

    // Step 3: Call Claude from popup context
    // showStatus('info', 'Reading documents with AI...');
    // const extractedData = await extractWithClaudeFromPopup(attachFiles, billFile, apiKey);

    // // Step 4: Merge and store
    // const finalData = mergeDataInPopup(extractedData, dealData, attachFiles);
    // const { files: fileData, ...dataWithoutFiles } = finalData;
    // await chrome.storage.local.set({ permitData: dataWithoutFiles });
    // await chrome.storage.local.set({ permitFiles: fileData });

    // Step 3: Send downloaded files to background for Claude processing
    showStatus('info', 'Reading documents with AI...');
    const processResponse = await chrome.runtime.sendMessage({
      action:      'processFiles',
      attachFiles: attachFiles,
      billFile:    billFile,
      dealData:    dealData,
      apiKey:      apiKey
    });

    if (processResponse.error) {
      showStatus('error', processResponse.error);
      setLoading(false);
      return;
    }

    // Step 5: Open form
    showStatus('info', 'Opening SaskPower form...');
    chrome.tabs.create({ url: 'https://www.saskpower.com/forms/net-metering-application-form' });
    showStatus('success', '✅ Form is opening! Switch to the new tab to review.');
    document.getElementById('steps').style.display = 'block';

  } catch (err) {
    showStatus('error', 'Something went wrong: ' + err.message);
  }

  setLoading(false);
}

async function downloadFileInPopup(meta) {
  if (!meta) return null;
  try {
    const resp = await fetch(meta.downloadUrl, { credentials: 'include' });
    if (resp.ok) {
      const ct = resp.headers.get('content-type') || '';
      if (!ct.includes('text/html')) {
        const blob = await resp.blob();
        const arrayBuf = await blob.arrayBuffer();
        const uint8 = new Uint8Array(arrayBuf);
        let binary = '';
        for (let i = 0; i < uint8.length; i++) binary += String.fromCharCode(uint8[i]);
        const b64 = btoa(binary);
        const mimeType = (blob.type && blob.type !== 'application/octet-stream') ? blob.type : null;
        const compressed = await compressImageIfNeeded(b64, blob.type);
        return { b64: compressed, mimeType: mimeType || blob.type };
      }
    }
  } catch(e) {
    console.error('Download failed for', meta.name, e);
  }
  return null;
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

async function extractWithClaudeFromPopup(attachFiles, billFile, apiKey) {
  const content = [];

  const addFile = (file) => {
    if (!file) return;
    const ext = (file.filename || '').split('.').pop().toLowerCase();
    const mt = (file.mimeType && file.mimeType !== 'application/octet-stream')
      ? file.mimeType
      : (ext === 'pdf' ? 'application/pdf' : ext === 'png' ? 'image/png' : 'image/jpeg');
    if (mt === 'application/pdf') {
      content.push({ type: 'document', source: { type: 'base64', media_type: mt, data: file.b64 } });
    } else {
      content.push({ type: 'image', source: { type: 'base64', media_type: mt, data: file.b64 } });
    }
  };

  addFile(billFile);
  addFile(attachFiles.sld);
  addFile(attachFiles.siteplan);

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
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      messages: [{ role: 'user', content }]
    })
  });

  if (!resp.ok) throw new Error(`Claude API error: ${resp.status}`);
  const json = await resp.json();
  const raw = json.content.map(b => b.text || '').join('').trim();
  const m = raw.match(/\{[\s\S]*\}/);
  return JSON.parse(m ? m[0] : raw);
}

function mergeDataInPopup(extracted, dealData, files) {
  const isoDate = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
  const month = String(isoDate.getMonth() + 1).padStart(2, '0');
  const day   = String(isoDate.getDate()).padStart(2, '0');
  const year  = isoDate.getFullYear();
  const cap   = str => str ? str.charAt(0).toUpperCase() + str.slice(1).toLowerCase() : '';

  const fileData = {};
  if (files.sld)      fileData.sld      = { b64: files.sld.b64,      filename: files.sld.filename,      mimeType: files.sld.mimeType };
  if (files.siteplan) fileData.siteplan = { b64: files.siteplan.b64, filename: files.siteplan.filename, mimeType: files.siteplan.mimeType };
  if (files.bill)     fileData.bill     = { b64: files.bill.b64,     filename: files.bill.filename,     mimeType: files.bill.mimeType };

  return {
    ...extracted,
    person1_first:           cap(extracted.person1_first  || ''),
    person1_last:            cap(extracted.person1_last   || ''),
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

function toggleSettings() {
  const panel = document.getElementById('settingsPanel');
  panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
}

async function saveSettings() {
  const key      = document.getElementById('apiKeyInput').value.trim();
  const clientId = document.getElementById('clientIdInput').value.trim();
  await chrome.storage.local.set({ apiKey: key, zohoClientId: clientId });
  document.getElementById('savedMsg').style.display = 'block';
  setTimeout(() => { document.getElementById('savedMsg').style.display = 'none'; }, 2000);
}

async function connectZoho() {
  const { zohoClientId } = await chrome.storage.local.get('zohoClientId');
  if (!zohoClientId) {
    document.getElementById('connectStatus').textContent = 'Enter your Zoho Client ID and save first.';
    return;
  }
  const redirectUri = chrome.identity.getRedirectURL();
  const scope = 'WorkDrive.files.READ WorkDrive.files.ALL';
  const authUrl = `https://accounts.zoho.com/oauth/v2/auth?response_type=token&client_id=${zohoClientId}&redirect_uri=${redirectUri}&scope=${scope}`;

  chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }, async (redirectUrl) => {
    if (chrome.runtime.lastError || !redirectUrl) {
      document.getElementById('connectStatus').textContent = 'Connection failed.';
      return;
    }
    const match = redirectUrl.match(/access_token=([^&]+)/);
    if (match) {
      await chrome.storage.local.set({ zohoToken: match[1] });
      document.getElementById('connectStatus').textContent = '✓ Connected!';
      document.getElementById('connectStatus').style.color = '#22c55e';
    }
  });
}

function show(id) {
  ['notDeal', 'noDrive', 'readyState'].forEach(s => {
    document.getElementById(s).style.display = s === id ? 'block' : 'none';
  });
}

function setLoading(active) {
  const btn     = document.getElementById('runBtn');
  const label   = document.getElementById('btnLabel');
  const spinner = document.getElementById('spinner');
  btn.disabled          = active;
  label.textContent     = active ? 'Working...' : '⚡ Fill SaskPower NEM Permit';
  spinner.style.display = active ? 'block' : 'none';
}

function showStatus(type, msg) {
  const el = document.getElementById('status');
  el.className     = `status ${type}`;
  el.textContent   = msg;
  el.style.display = 'block';
}