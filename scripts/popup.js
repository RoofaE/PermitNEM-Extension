'use strict';

let dealData = null;

document.addEventListener('DOMContentLoaded', async () => {
  // Wire up all buttons first — always, regardless of page
  document.getElementById('runBtn')?.addEventListener('click', runPermit);
  document.querySelector('.settings-link')?.addEventListener('click', toggleSettings);
  document.querySelector('.settings-save')?.addEventListener('click', saveSettings);
  document.getElementById('connectZohoBtn')?.addEventListener('click', connectZoho);

  // Load saved API key
  const { apiKey } = await chrome.storage.local.get('apiKey');
  if (apiKey) document.getElementById('apiKeyInput').value = apiKey;

  // Get current tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url || '';
  const isDealsPage = url.includes('crm.zoho.com') && url.includes('/tab/Potentials/');

  if (!isDealsPage) {
    show('notDeal');
    return;
  }

  try {
    const response = await chrome.tabs.sendMessage(tab.id, { action: 'getDealData' });

    if (!response || !response.success) {
      show('notDeal');
      return;
    }

    dealData = response.data;

    if (!dealData.workdriveUrl) {
      show('noDrive');
      return;
    }

    document.getElementById('clientName').textContent  = dealData.clientName || '—';
    document.getElementById('clientEmail').textContent = dealData.email || '';
    document.getElementById('clientPhone').textContent = dealData.phone || '';
    show('readyState');

  } catch (err) {
    show('notDeal');
  }
});

async function runPermit() {
  const { apiKey, zohoClientId } = await chrome.storage.local.get(['apiKey', 'zohoClientId']);
  if (apiKey) document.getElementById('apiKeyInput').value = apiKey;
  if (zohoClientId) document.getElementById('clientIdInput').value = zohoClientId;
  if (!apiKey) {
    showStatus('error', 'No API key set. Click ⚙ Settings and add your Anthropic API key.');
    return;
  }
  if (!dealData?.workdriveUrl) {
    showStatus('error', 'No WorkDrive URL found on this deal.');
    return;
  }

  setLoading(true);
  showStatus('info', 'Reading WorkDrive files...');

  try {
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

    showStatus('info', 'Opening SaskPower form...');
    await chrome.storage.local.set({ permitData: response.data });
    chrome.tabs.create({ url: 'https://www.saskpower.com/forms/net-metering-application-form' });
    showStatus('success', '✅ Form is opening! Switch to the new tab to review.');
    document.getElementById('steps').style.display = 'block';

  } catch (err) {
    showStatus('error', 'Something went wrong: ' + err.message);
  }

  setLoading(false);
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
    document.getElementById('connectStatus').textContent = 'Enter your Zoho Client ID below first.';
    return;
  }

  const redirectUri = chrome.identity.getRedirectURL();
  const scope = 'WorkDrive.files.READ WorkDrive.files.ALL';
  const authUrl = `https://accounts.zoho.com/oauth/v2/auth?response_type=token&client_id=${zohoClientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${scope}`;

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
