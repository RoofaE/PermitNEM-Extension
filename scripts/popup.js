'use strict';

let dealData = null;

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  // Load saved API key into settings
  const { apiKey } = await chrome.storage.local.get('apiKey');
  if (apiKey) document.getElementById('apiKeyInput').value = apiKey;

  // Get current tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url   = tab?.url || '';

  // Check if on Zoho CRM Deals page
  const isDealsPage = url.includes('crm.zoho.com') && url.includes('/tab/Potentials/');

  if (!isDealsPage) {
    show('notDeal');
    return;
  }

  // Ask content script for deal data
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

    // Show ready state
    document.getElementById('clientName').textContent  = dealData.clientName  || '—';
    document.getElementById('clientEmail').textContent = dealData.email        || '';
    document.getElementById('clientPhone').textContent = dealData.phone        || '';
    show('readyState');

  } catch (err) {
    show('notDeal');
  }
});


// ─── Run Permit ───────────────────────────────────────────────────────────────

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
  showStatus('info', 'Reading WorkDrive files...');

  try {
    // Send to background script to do the heavy lifting
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

    // Open SaskPower form in new tab with extracted data
    showStatus('info', 'Opening SaskPower form...');

    await chrome.storage.local.set({ permitData: response.data });

    chrome.tabs.create({
      url: 'https://www.saskpower.com/forms/net-metering-application-form'
    });

    showStatus('success', '✅ Form is opening! Switch to the new tab to review.');
    document.getElementById('steps').style.display = 'block';

  } catch (err) {
    showStatus('error', 'Something went wrong: ' + err.message);
  }

  setLoading(false);
}


// ─── Settings ─────────────────────────────────────────────────────────────────

function toggleSettings() {
  const panel = document.getElementById('settingsPanel');
  panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
}

async function saveSettings() {
  const key = document.getElementById('apiKeyInput').value.trim();
  await chrome.storage.local.set({ apiKey: key });
  document.getElementById('savedMsg').style.display = 'block';
  setTimeout(() => { document.getElementById('savedMsg').style.display = 'none'; }, 2000);
}


// ─── Helpers ──────────────────────────────────────────────────────────────────

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

document.getElementById('runBtn').addEventListener('click', runPermit);
document.querySelector('.settings-link').addEventListener('click', toggleSettings);
document.querySelector('.settings-save').addEventListener('click', saveSettings);
