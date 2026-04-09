'use strict';

// Reads the current Zoho CRM Deal page and extracts client data
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action !== 'getDealData') return;

  try {
    const data = extractDealData();
    sendResponse({ success: true, data });
  } catch (err) {
    sendResponse({ success: false, error: err.message });
  }

  return true; // keep channel open for async
});


function extractDealData() {
  const data = {};

  // ── Client name ──
  // Try the page heading first
  const heading = document.querySelector('.zcrmRecordName, [data-field="Deal_Name"], .zc-ellipsis');
  if (heading) {
    data.clientName = heading.textContent.trim();
  }

  // ── Read all field label→value pairs on the page ──
  const fieldMap = buildFieldMap();

  // First Name + Last Name
  const firstName = fieldMap['First Name'] || '';
  const lastName  = fieldMap['Last Name']  || '';
  if (firstName || lastName) {
    data.clientName = `${firstName} ${lastName}`.trim();
    data.firstName  = capitalize(firstName);
    data.lastName   = capitalize(lastName);
  }

  // Email — use Email 1, fallback to Email 2
  data.email = fieldMap['Email 1'] || fieldMap['Email'] || fieldMap['Email 2'] || '';

  // Phone — use Phone 1, fallback to Phone 2
  data.phone = fieldMap['Phone 1'] || fieldMap['Phone'] || fieldMap['Phone 2'] || fieldMap['Mobile'] || '';

  // Street address
  data.streetAddress = fieldMap['Street Address'] || '';

  // City
  const cityProv = fieldMap['City & Province'] || fieldMap['City/Province'] || '';
  data.city = cityProv.split(',')[0].trim();

  // WorkDrive folder URL
  data.workdriveUrl = fieldMap['Workdrive Folder URL'] || fieldMap['WorkDrive Folder URL'] || fieldMap['Workdrive Folder Url'] || '';

  // WorkDrive folder ID (backup)
  data.workdriveFolderId = fieldMap['Workdrive Folder ID'] || fieldMap['WorkDrive Folder ID'] || '';

  // Deal ID from URL
  const urlMatch = window.location.href.match(/\/(\d+)\/?$/);
  data.dealId = urlMatch ? urlMatch[1] : '';

  return data;
}


function buildFieldMap() {
  const map = {};

  // Zoho CRM renders fields as label + value pairs
  // Try multiple selector patterns Zoho uses
  const containers = document.querySelectorAll(
    '.zcrmFieldContainer, .zc-field-container, [data-field], .zcrmLayoutField'
  );

  containers.forEach(container => {
    const labelEl = container.querySelector(
      '.zcrmFieldLabel, .zc-field-label, label, [class*="label"]'
    );
    const valueEl = container.querySelector(
      '.zcrmFieldValue, .zc-field-value, [class*="value"], a, span:not([class*="label"])'
    );

    if (labelEl && valueEl) {
      const label = labelEl.textContent.trim().replace(/:$/, '');
      const value = valueEl.textContent.trim();
      if (label && value && value !== '—' && value !== '-') {
        map[label] = value;
      }
    }
  });

  // Also try the detail view table rows
  document.querySelectorAll('tr.zcrmFieldRow, .zc-row').forEach(row => {
    const cells = row.querySelectorAll('td, .zc-col');
    if (cells.length >= 2) {
      const label = cells[0].textContent.trim().replace(/:$/, '');
      const value = cells[1].textContent.trim();
      if (label && value && value !== '—') {
        map[label] = value;
      }
    }
  });

  // Grab WorkDrive URL specifically from anchor tags
  document.querySelectorAll('a[href*="workdrive.zoho.com"]').forEach(a => {
    map['Workdrive Folder URL'] = a.href;
  });

  return map;
}


function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}
