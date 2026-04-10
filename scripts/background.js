'use strict';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'runPermit') {
    handleRunPermit(msg.dealData, msg.apiKey)
      .then(result => sendResponse(result))
      .catch(err  => sendResponse({ error: err.message }));
    return true;
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'runPermit') {
    handleRunPermit(msg.dealData, msg.apiKey)
      .then(result => sendResponse(result))
      .catch(err  => sendResponse({ error: err.message }));
    return true;
  }
  if (msg.action === 'processFiles') {
    handleProcessFiles(msg.attachFiles, msg.billFile, msg.dealData, msg.apiKey)
      .then(result => sendResponse(result))
      .catch(err  => sendResponse({ error: err.message }));
    return true;
  }
});

async function handleProcessFiles(attachFiles, billFile, dealData, apiKey) {
  const extractedData = await extractWithClaude(attachFiles, billFile, apiKey);
  const finalData = mergeData(extractedData, dealData, attachFiles);
  const { files: fileData, ...dataWithoutFiles } = finalData;
  await chrome.storage.local.set({ permitData: dataWithoutFiles });
  await chrome.storage.local.set({ permitFiles: fileData });
  return { success: true };
}

async function handleRunPermit(dealData, apiKey) {
  const workdriveUrl = dealData.workdriveUrl;
  if (!workdriveUrl) throw new Error('No WorkDrive URL found on this deal.');
  const folderId = extractFolderId(workdriveUrl);
  if (!folderId) throw new Error('Could not extract folder ID from WorkDrive URL.');

  console.log('PermitFlow: Crawling WorkDrive folder...');
  const allFiles = await crawlWorkDrive(folderId);
  console.log(`PermitFlow: Found ${allFiles.length} files total`);

  const scored = allFiles.map(f => ({ ...f, score: scoreFile(f.name) }));

  const sldFile  = findBestMatch(scored, 'sld');
  const siteFile = findBestMatch(scored, 'siteplan');
  const specFile = findBestMatch(scored, 'spec');
  const billFile = findBestMatch(scored, 'bill');

  console.log('PermitFlow: SLD →',       sldFile?.name);
  console.log('PermitFlow: Site plan →',  siteFile?.name);
  console.log('PermitFlow: Spec sheet →', specFile?.name);
  console.log('PermitFlow: Bill →',       billFile?.name);

  return {
    success: true,
    filesMeta: {
      sld:      sldFile  ? { downloadUrl: sldFile.downloadUrl,  permalink: sldFile.permalink,  name: sldFile.name,  id: sldFile.id  } : null,
      siteplan: siteFile ? { downloadUrl: siteFile.downloadUrl, permalink: siteFile.permalink, name: siteFile.name, id: siteFile.id } : null,
      spec:     specFile ? { downloadUrl: specFile.downloadUrl, permalink: specFile.permalink, name: specFile.name, id: specFile.id } : null,
      bill:     billFile ? { downloadUrl: billFile.downloadUrl, permalink: billFile.permalink, name: billFile.name, id: billFile.id } : null,
    },
  };
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
        });
        console.log(`PermitFlow: Found file — ${attrs.name}`);
      }
    }
  }

  return files;
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