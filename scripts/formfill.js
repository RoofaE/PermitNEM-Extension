'use strict';

// Runs on the SaskPower NEM form page
// Waits for data from storage then fills everything

const PIONEER = {
  company:      'Pioneer Solar & Renewables Inc.',
  address:      '4003 Millar Ave #Bay 2',
  city:         'Saskatoon',
  province:     'Saskatchewan',
  postal:       'S7K 2K6',
  contact_name: 'Roofa Etagiuri',
  phone:        '(306) 384-7657',
  email:        'support@pioneersolarenergy.com',
};

const REQUESTOR = {
  name:  'Roofa Etagiuri',
  phone: '(306) 384-7657',
  email: 'support@pioneersolarenergy.com',
};


// ─── Wait for page + data ─────────────────────────────────────────────────────

async function init() {
  // Wait for form to fully load
  await waitFor('[data-sc-field-name="Location Type Input"]', 15000);

  // Get permit data from storage
  const { permitData, permitFiles } = await chrome.storage.local.get(['permitData', 'permitFiles']);
  if (!permitData) {
    console.error('PermitFlow: No permit data found in storage.');
    return;
  }
  const fullData = { ...permitData, files: permitFiles };
  await fillForm(fullData);
}

function waitFor(selector, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const el = document.querySelector(selector);
    if (el) return resolve(el);
    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) { observer.disconnect(); resolve(el); }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => { observer.disconnect(); reject(new Error(`Timeout waiting for ${selector}`)); }, timeout);
  });
}


// ─── Fill helpers ─────────────────────────────────────────────────────────────

function sc(name) { return `[data-sc-field-name="${name}"]`; }

function w(ms = 300) { return new Promise(r => setTimeout(r, ms)); }

async function f(fieldName, value) {
  if (value === null || value === undefined || String(value).trim() === '') return;
  const el = document.querySelector(sc(fieldName));
  if (!el) { console.warn(`PermitFlow: field not found — ${fieldName}`); return; }

  const type = el.getAttribute('type') || '';
  if (type === 'number') {
    // Use native setter for number inputs
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    nativeSetter.call(el, String(value));
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } else if (el.tagName === 'TEXTAREA') {
    el.value = String(value);
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    el.focus();
    el.value = String(value);
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
  }
  console.log(`PermitFlow: ✓ ${fieldName}: ${value}`);
}

async function sel(fieldName, value) {
  const el = document.querySelector(sc(fieldName));
  if (!el) { console.warn(`PermitFlow: select not found — ${fieldName}`); return; }
  // Try by value, then by label text
  const opts = Array.from(el.options);
  const opt  = opts.find(o => o.value === value || o.text.trim() === value || o.text.trim().startsWith(value));
  if (opt) {
    el.value = opt.value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    console.log(`PermitFlow: ✓ ${fieldName}: ${opt.text}`);
  } else {
    console.warn(`PermitFlow: option "${value}" not found in ${fieldName}`);
  }
}

async function radio(fieldName, value) {
  const el = document.querySelector(`${sc(fieldName)}[value="${value}"]`);
  if (el) {
    el.checked = true;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.click();
    console.log(`PermitFlow: ✓ radio ${fieldName}: ${value}`);
    return;
  }
  // Fallback: click label
  const labels = Array.from(document.querySelectorAll('label'));
  const label  = labels.find(l => l.textContent.trim() === value);
  if (label) { label.click(); console.log(`PermitFlow: ✓ radio (label) ${value}`); }
  else console.warn(`PermitFlow: radio not found — ${fieldName}: ${value}`);
}

async function checkBox(fieldName) {
  const el = document.querySelector(sc(fieldName));
  if (!el) { console.warn(`PermitFlow: checkbox not found — ${fieldName}`); return; }
  if (!el.checked) {
    el.checked = true;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.click();
  }
  console.log(`PermitFlow: ✓ checked ${fieldName}`);
}

async function fillEmailBoth(fieldName, value) {
  if (!value) return;
  const els = document.querySelectorAll(sc(fieldName));
  els.forEach(el => {
    el.value = value;
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  console.log(`PermitFlow: ✓ ${fieldName} (all): ${value}`);
}


// ─── File attachment ──────────────────────────────────────────────────────────

async function attachFiles(filesData) {
  const uploadInput = document.querySelector('input[type="file"]');
  if (!uploadInput) { console.warn('PermitFlow: file upload input not found'); return; }

  const fileList = [];

  for (const key of ['sld', 'siteplan', 'bill']) {
    const fileInfo = filesData[key];
    if (!fileInfo) continue;

    // Convert base64 back to File object
    const byteChars = atob(fileInfo.b64);
    const byteArr   = new Uint8Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) byteArr[i] = byteChars.charCodeAt(i);
    const blob = new Blob([byteArr], { type: fileInfo.mimeType });
    const file = new File([blob], fileInfo.filename, { type: fileInfo.mimeType });
    fileList.push(file);
  }

  // Use DataTransfer to attach multiple files
  const dt = new DataTransfer();
  fileList.forEach(f => dt.items.add(f));
  uploadInput.files = dt.files;
  uploadInput.dispatchEvent(new Event('change', { bubbles: true }));
  console.log(`PermitFlow: ✓ Attached ${fileList.length} files`);
}

function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

// ─── Main form fill ───────────────────────────────────────────────────────────

async function fillForm(data) {

  // ── 1. Power Generation System ──
  console.log('PermitFlow: [1/8] Power Generation System');
  await radio('Location Type Input', 'Urban');
  await w(400);
  await radio('Is Electric Required', 'No');
  await w(300);
  await radio('Standby Switch Required', 'No');
  await w(300);

  // Account number — strip spaces
  const acct = String(data.account_number || '').replace(/\s/g, '');
  await f('Account Number Value', acct);

  await sel('Type of Generation Dropdown List', 'Solar');
  await w(300);

  // Voltage — try multiple formats
  const voltEl = document.querySelector(sc('Voltage Dropdown List'));
  if (voltEl) {
    const opts = Array.from(voltEl.options);
    const opt  = opts.find(o => o.text.trim().startsWith('120/240'));
    if (opt) {
      voltEl.value = opt.value;
      voltEl.dispatchEvent(new Event('change', { bubbles: true }));
      console.log(`PermitFlow: ✓ Voltage: ${opt.text}`);
    }
  }
  await w(300);

  await f('Modules Input',             data.num_modules);
  await f('Module Size Input',         '620');
  await f('Total Inverter Size Input', data.total_inverter_kw);
  await w(400);

  // ── 2. Service Address ──
  console.log('PermitFlow: [2/8] Service Address');
  const locType = (data.location_type || 'city').toLowerCase();

  if (locType === 'city') {
    await checkBox('City or Town Section');
    await w(500);
    await f('Civic house Input',               data.house_number);
    await f('Civic Street Input',              data.street_name);
    await f('Civic Address Lot Input',         'N/A');
    await f('Civic Address Block Input',       'N/A');
    await f('Civic Address Plan Number Input', 'N/A');
    await f('Civic Address City Input',        data.city);

  } else if (locType === 'rural') {
    await checkBox('Rural Location Section');
    await w(500);
    await sel('Legal Land Quarter Input',  data.qtr_lsd  || '');
    await f('Legal Land Section Input',    data.section  || '');
    await f('Legal Land Township Input',   data.township || '');
    await f('Legal Land Range Input',      data.range    || '');
    await sel('Legal Land Meridian Input', data.meridian || 'W');
    await f('Legal Land house Input',      data.house_number || '');
    await f('Legal Street Input',          data.street_name  || '');
    await f('Legal Land Lot Input',        'N/A');
    await f('Legal Land Block Input',      'N/A');
    await f('Legal Land Plan Input',       'N/A');
    await f('Legal Land City Input',       data.city);

  } else if (locType === 'firstnation') {
    await checkBox('First Nation Addresses');
    await w(500);
    await f('Civic house Input',               data.house_number || '');
    await f('Civic Street Input',              data.street_name  || '');
    await f('Civic Address Lot Input',         'N/A');
    await f('Civic Address Block Input',       'N/A');
    await f('Civic Address Plan Number Input', 'N/A');
    await f('Civic Address City Input',        data.city);
    await f('First Nation name',               data.first_nation_name || '');
    await f('Reserve Name',                    data.reserve_name      || '');
  }
  await w(400);

  // ── 3. Site Plan + Date ──
  console.log('PermitFlow: [3/8] Files & Date');
  if (data.files) await attachFiles(data.files);
  await f('Proposed Interconnection Date Input', data.interconnection_date);
  await w(400);

  // ── 4. Applicant Information ──
  console.log('PermitFlow: [4/8] Applicant');
  await radio('Applicant Type Input', 'Private Owner');
  await w(400);
  await f('Applicant First Name Input',      capitalize(data.person1_first));
  await f('Applicant Middle Name Input',     (data.person1_middle_initial || '').toUpperCase());
  await f('Applicant Last Name Input',       capitalize(data.person1_last));
  await f('Applicant Mailing Address Input', data.person1_mailing_address);
  await f('Applicant City Input',            data.person1_city);
  await f('Applicant Postal Code Input',     data.person1_postal || data.postal_code);

  if (data.person1_phone) {
    await f('Applicant Home Phone Input', data.person1_phone);
    await f('Applicant Cell Phone Input', data.person1_phone);
  }
  if (data.person1_email) {
    await fillEmailBoth('Applicant Email Input', data.person1_email);
  }
  await w(400);

  // ── 5. Emergency & Privacy ──
  console.log('PermitFlow: [5/8] Privacy fields');
  await f('Applicant Emergency Contact Name Input', 'N/A');
  await f('Place of Employment Input',              'N/A');
  await f('Mothers Maiden Name Input',              'N/A');
  await f('Drivers License Input',                  'N/A');
  await w(300);

  // ── 6. Co-applicant ──
console.log('PermitFlow: [6/8] Co-applicant');
  if (data.has_second_person && data.person2_first) {
    try {
      const addBtn = Array.from(document.querySelectorAll('a, button, span'))
        .find(el => el.textContent.trim() === 'Add a co-applicant');
      if (addBtn) { addBtn.click(); await w(1200); }
    } catch(e) {}

    const p2First  = capitalize(data.person2_first);
    const p2Last   = capitalize(data.person2_last);
    const p2Middle = (data.person2_middle_initial || '').toUpperCase();

    const coRadio = document.querySelector(`[data-sc-field-name="Co-Applicant Type Input"][value="Private Owner"]`);
    if (coRadio) { coRadio.checked = true; coRadio.click(); }
    await w(400);

    await f('Co-Applicant First Name Input',  p2First);
    await f('Co-Applicant Middle Name Input', p2Middle);
    await f('Co-Applicant Last Name Input',   p2Last);
    await f('Co-Applicant Mailing Address Input', data.person1_mailing_address);
    await f('Co-Applicant City Input',            data.person1_city);
    await f('Co-Applicant Postal Code Input',     data.person1_postal || data.postal_code);

    if (data.person1_phone) {
      await f('Co-Applicant Home Phone Input', data.person1_phone);
      await f('Co-Applicant Cell Phone Input', data.person1_phone);
    }
    if (data.person1_email) {
      await fillEmailBoth('Co-Applicant Email Input', data.person1_email);
    }

    await f('Co-Applicant Emergency Contact Name Input', 'N/A');
    await f('Co-Applicant Place of Employment Input',    'N/A');
    await f('Co-Applicant Mothers Maiden Name Input',    'N/A');
    await f('Co-Applicant Drivers License Input',        'N/A');
  }

  // ── 7. Requestor + Supplier ──
  console.log('PermitFlow: [7/8] Requestor & Supplier');

  // Check "making request for someone else"
  const makeReqEl = document.querySelector(sc('Making Request'));
  if (makeReqEl && !makeReqEl.checked) {
    makeReqEl.click();
    await w(500);
  }

  await f('Requester Name Input',  REQUESTOR.name);
  await f('Requester Mobile Input', REQUESTOR.phone);
  await fillEmailBoth('Requester Email Input', REQUESTOR.email);
  await w(300);

  await f('Supplier Business Name Input',   PIONEER.company);
  await f('Supplier Mailing Address Input', PIONEER.address);
  await f('Supplier City Input',            PIONEER.city);
  await f('Supplier Postal Code Input',     PIONEER.postal);
  await f('Supplier Contact First Name',    PIONEER.contact_name);
  await f('Supplier Contact Cell Phone',    PIONEER.phone);
  await fillEmailBoth('Supplier Contact Email', PIONEER.email);
  await w(300);

  // ── 8. Comments ──
  console.log('PermitFlow: [8/8] Comments');
  const commentEl = document.querySelector("textarea[data-sc-field-name='Comments']");
  if (commentEl) {
    commentEl.value = data.comment;
    commentEl.dispatchEvent(new Event('input',  { bubbles: true }));
    commentEl.dispatchEvent(new Event('change', { bubbles: true }));
    console.log(`PermitFlow: ✓ Comments: ${data.comment}`);
  }

  await w(500);
  console.log('PermitFlow: ✅ Form fill complete! Review and submit.');

  // Show a nice banner on the page
  showBanner();
}


function showBanner() {
  const banner = document.createElement('div');
  banner.style.cssText = `
    position: fixed; top: 20px; right: 20px; z-index: 99999;
    background: #1a1a1a; color: white;
    padding: 16px 20px; border-radius: 12px;
    font-family: sans-serif; font-size: 14px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.3);
    max-width: 300px; line-height: 1.5;
  `;
  banner.innerHTML = `
    <div style="font-weight:600;margin-bottom:6px;">⚡ PermitFlow — Form Filled!</div>
    <div style="font-size:12px;color:#aaa;">Review everything, then check "I agree" and click Submit.</div>
    <div style="margin-top:10px;font-size:12px;color:#aaa;">Co-applicant: add manually if needed.</div>
    <div style="margin-top:8px;text-align:right">
      <span onclick="this.parentElement.parentElement.remove()" style="cursor:pointer;font-size:12px;color:#666;">Dismiss ✕</span>
    </div>
  `;
  document.body.appendChild(banner);
  setTimeout(() => banner.remove(), 15000);
}


// ─── Start ────────────────────────────────────────────────────────────────────
init().catch(err => console.error('PermitFlow error:', err));
