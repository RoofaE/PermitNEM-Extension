'use strict';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action !== 'getDealData') return;
  try {
    const data = extractDealData();
    sendResponse({ success: true, data });
  } catch (err) {
    sendResponse({ success: false, error: err.message });
  }
  return true;
});

function extractDealData() {
  const data = {};

  // ── Scrape all label/value pairs from the visible page ──
  const fieldMap = {};

  // Zoho renders fields as adjacent divs with label text + value text
  // Look for elements containing field labels
  document.querySelectorAll('.dv_info_label, .dv-info-label, [id*="labelTD"]').forEach(labelEl => {
    const label = labelEl.textContent.trim().replace(/:$/, '');
    if (!label) return;

    // Value is usually in a sibling or nearby element
    const parent = labelEl.closest('.dv_info_field, .flexOne, [class*="field_column"], div[class*="dv_field"]');
    if (parent) {
      const valueEl = parent.querySelector('.dv_info_value, [id*="value_"], [class*="dv_info_value"], span[id*="POTENTIAL"]');
      if (valueEl) {
        const value = valueEl.textContent.trim();
        if (value && value !== '—' && value !== '') {
          fieldMap[label] = value;
        }
      }
    }
  });

  // Fallback — scan all text on page for known patterns
  // Email — look for email links directly
  const emailLink = document.querySelector('a[href^="mailto:"]');
  if (emailLink) {
    data.email = emailLink.textContent.trim() || emailLink.href.replace('mailto:', '');
  }

  // Phone — look for phone component value
  const phoneEl = document.querySelector('.cxPhoneViewValue, [class*="PhoneValue"]');
  if (phoneEl) {
    data.phone = phoneEl.textContent.trim();
  }

  // Fallback phone — look for viewport value attribute
  if (!data.phone) {
    const phoneComp = document.querySelector('[viewportvalue]');
    if (phoneComp) {
      data.phone = phoneComp.getAttribute('viewportvalue');
    }
  }

  // Names — from page heading or field map
  const nameEl = document.querySelector('[data-zqa="crm-detail-name"], .entity-name-field, [id*="POTENTIALNAME"] span');
  if (nameEl) data.clientName = nameEl.textContent.trim();

  // First/Last from CRM fields
  data.firstName = fieldMap['First Name'] || '';
  data.lastName  = fieldMap['Last Name']  || '';
  if (data.firstName || data.lastName) {
    data.clientName = `${data.firstName} ${data.lastName}`.trim();
  }

  // Street address
  data.streetAddress = fieldMap['Street Address'] || '';

  // City
  const cityProv = fieldMap['City & Province'] || '';
  data.city = cityProv.split(',')[0].trim();

  // WorkDrive URL — most reliable, grab from anchor tag
  const wdLink = document.querySelector('a[href*="workdrive.zoho.com/folder"]');
  if (wdLink) data.workdriveUrl = wdLink.href;

  // Email fallback from field map
  if (!data.email) {
    data.email = fieldMap['Email 1'] || fieldMap['Email'] || '';
  }

  // Phone fallback from field map  
  if (!data.phone) {
    data.phone = fieldMap['Phone 2'] || fieldMap['Phone 1'] || fieldMap['Phone'] || '';
  }

  // Deal ID from URL
  const urlMatch = window.location.href.match(/\/(\d+)\/?$/);
  data.dealId = urlMatch ? urlMatch[1] : '';

  console.log('PermitFlow CRM data:', data);
  return data;
}
