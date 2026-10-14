const toastEl = document.getElementById('toast');
function toast(msg, isError = false) {
  toastEl.textContent = msg;
  toastEl.className = 'toast visible' + (isError ? ' error' : '');
  setTimeout(() => toastEl.classList.remove('visible'), 3500);
}

const STATUS_LABEL = {
  valid: 'Valid', warning: 'Warning', critical: 'Critical',
  expired: 'Expired', error: 'Error', pending: 'Checking…'
};

function daysText(d) {
  if (d === null || d === undefined) return '';
  if (d < 0) return `expired ${Math.abs(d)}d ago`;
  if (d === 0) return 'expires today';
  return `${d} day${d === 1 ? '' : 's'} left`;
}

function timeAgo(iso) {
  if (!iso) return 'not yet checked';
  const diffMin = Math.floor((Date.now() - new Date(iso + 'Z').getTime()) / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const h = Math.floor(diffMin / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function dotColor(status) {
  return {
    valid: '#1B8F5C', warning: '#A8760A', critical: '#C6472F',
    expired: '#D8453A', error: '#8A8A8A', pending: '#5B707C'
  }[status] || '#5B707C';
}

// Plans store an effectively-infinite domainLimit for the "unlimited" tier
// so the normal count >= limit check never blocks it — but we don't want
// to literally print that huge number anywhere in the UI.
function formatLimit(n) {
  return n >= 100000 ? 'Unlimited' : n;
}

// ---------------- State ----------------
let currentUser = null;
let currentPlans = null;
let allDomains = [];
let allGroups = [];
let activeFilter = 'all';       // status filter: all | valid | warning | critical
let activeGroupFilter = 'all';  // group filter: 'all' (not a real group) | a group id
let assignSelectInitialized = false;

const groupNameById = (id) => {
  const g = allGroups.find(g => g.id === id);
  return g ? g.name : null;
};
const generalGroup = () => allGroups.find(g => g.name === 'General');

// ---------------- Rendering ----------------
function getRealertIntervalLabel() {
  const plan = currentUser?.plan || 'trial';
  const planObj = currentPlans ? currentPlans[plan] : null;
  const mins = planObj?.criticalIntervalMinutes;
  if (mins) {
    return mins >= 60 ? `${mins / 60} hr` : `${mins} min`;
  }
  const map = { pro: '30 min', agency: '10 min', enterprise: '10 min', growth: '1 hr', starter: '2 hrs', micro: '3 hrs', trial: '3 hrs' };
  return map[plan] || '30 min';
}

function domainRowHTML(d) {
  const status = d.status || 'pending';
  const isAlertable = ['warning', 'critical', 'expired'].includes(status);
  const groupName = groupNameById(d.group_id);

  const detail = status === 'error'
    ? (d.last_error || 'Could not verify certificate')
    : d.days_left !== null && d.days_left !== undefined
      ? `${d.issuer || 'Unknown issuer'} · ${daysText(d.days_left)} · checked ${timeAgo(d.last_checked_at)}`
      : `Checking for the first time…`;

  const ackHint = isAlertable
    ? (d.alert_acknowledged
        ? `<div class="group-tag" style="background:#EAF2F5;color:var(--muted);">Alerts paused</div>`
        : `<div class="group-tag" style="background:#FDE9E3;color:var(--coral);">Re-alerting every ${getRealertIntervalLabel()}</div>`)
    : '';

  const isInternal = d.source === 'internal';

  return `
    <div class="domain-row" data-id="${d.id}">
      <span class="dot" style="background:${dotColor(status)}"></span>
      <div>
        <div class="host">${escapeHtml(d.hostname)}${!isInternal && d.port !== 443 ? ':' + d.port : ''}</div>
        <div class="meta">${escapeHtml(detail)}</div>
        <div style="display:flex; gap:6px; flex-wrap:wrap; margin-top:4px;">
          ${isInternal ? `<span class="source-tag internal-ca-tag">🛡️ Internal Root CA</span>` : ''}
          ${groupName ? `<span class="group-tag">${escapeHtml(groupName)}</span>` : ''}
          ${ackHint}
        </div>
      </div>
      <div class="spacer"></div>
      <span class="pill pill-${status}">${STATUS_LABEL[status] || status}</span>
      ${isAlertable && !d.alert_acknowledged
        ? `<button class="btn btn-accent btn-sm" data-action="ack">Acknowledge</button>` : ''}
      ${isInternal ? `<button class="btn btn-ghost btn-sm" data-action="update-cert" title="Update or renew this internal certificate">Update Cert</button>` : `<button class="btn btn-ghost btn-sm" data-action="check">Re-check</button>`}
      <button class="btn btn-danger btn-sm" data-action="delete">Remove</button>
    </div>`;
}

function matchesStatusFilter(d) {
  if (activeFilter === 'all') return true;
  if (activeFilter === 'valid') return d.status === 'valid';
  if (activeFilter === 'warning') return d.status === 'warning';
  if (activeFilter === 'critical') return d.status === 'critical' || d.status === 'expired';
  return true;
}

function matchesGroupFilter(d) {
  if (activeGroupFilter === 'all') return true; // "All" isn't a group — just shows everything
  const gg = generalGroup();
  if (gg && activeGroupFilter === gg.id) {
    // Domains added before groups existed have group_id = null — treat those as General too.
    return d.group_id === gg.id || d.group_id === null || d.group_id === undefined;
  }
  return d.group_id === activeGroupFilter;
}

let domainCurrentPage = 1;
const domainPageSize = 5;

function renderDomains() {
  const listEl = document.getElementById('domainList');
  const inGroup = allDomains.filter(matchesGroupFilter);   // scoped by the selected group
  const visible = inGroup.filter(matchesStatusFilter);      // then narrowed by status

  if (allDomains.length === 0) {
    listEl.innerHTML = `
      <div class="empty-state">
        <h3>No domains yet</h3>
        <p>Add your first domain above — we'll check its certificate right away.</p>
      </div>`;
    renderDomainsPagination(0, 0);
  } else if (visible.length === 0) {
    listEl.innerHTML = `
      <div class="empty-state">
        <h3>Nothing here</h3>
        <p>No domains match this filter right now.</p>
      </div>`;
    renderDomainsPagination(0, 0);
  } else {
    const totalPages = Math.ceil(visible.length / domainPageSize);
    if (domainCurrentPage > totalPages) domainCurrentPage = totalPages;
    if (domainCurrentPage < 1) domainCurrentPage = 1;

    const startIndex = (domainCurrentPage - 1) * domainPageSize;
    const pageItems = visible.slice(startIndex, startIndex + domainPageSize);

    listEl.innerHTML = pageItems.map(domainRowHTML).join('');
    renderDomainsPagination(totalPages, visible.length);
  }

  // Stat counts reflect the selected group — "how many warning/critical/ok
  // certs *in this group*", not the whole account.
  const counts = inGroup.reduce((acc, d) => {
    acc.total++;
    if (d.status === 'valid') acc.valid++;
    else if (d.status === 'warning') acc.warning++;
    else if (d.status === 'critical' || d.status === 'expired') acc.critical++;
    return acc;
  }, { total: 0, valid: 0, warning: 0, critical: 0 });

  document.getElementById('statTotal').textContent = counts.total;
  document.getElementById('statValid').textContent = counts.valid;
  document.getElementById('statWarning').textContent = counts.warning;
  document.getElementById('statCritical').textContent = counts.critical;

  document.querySelectorAll('.stat-card').forEach(card => {
    card.classList.toggle('active', card.dataset.filter === activeFilter);
  });

  const bar = document.getElementById('activeFilterBar');
  if (activeFilter === 'all') {
    bar.style.display = 'none';
  } else {
    bar.style.display = 'flex';
    const labels = { valid: 'Showing healthy domains', warning: 'Showing domains expiring soon', critical: 'Showing critical / expired domains' };
    document.getElementById('activeFilterLabel').textContent = labels[activeFilter] || '';
  }

  renderGroupSelect();
}

function renderDomainsPagination(totalPages, totalItems) {
  let container = document.getElementById('domainsPagination');
  if (!container) {
    container = document.createElement('div');
    container.id = 'domainsPagination';
    container.className = 'pagination-bar';
    const listEl = document.getElementById('domainList');
    if (listEl && listEl.parentNode) {
      listEl.parentNode.insertBefore(container, listEl.nextSibling);
    }
  }

  if (!container) return;

  if (totalPages <= 1) {
    container.innerHTML = totalItems > 0 ? `<span>Showing all ${totalItems} domain${totalItems === 1 ? '' : 's'}</span>` : '';
    return;
  }

  const startItem = (domainCurrentPage - 1) * domainPageSize + 1;
  const endItem = Math.min(domainCurrentPage * domainPageSize, totalItems);

  let pageButtonsHtml = '';
  for (let p = 1; p <= totalPages; p++) {
    if (p === 1 || p === totalPages || (p >= domainCurrentPage - 2 && p <= domainCurrentPage + 2)) {
      pageButtonsHtml += `<button class="page-btn ${p === domainCurrentPage ? 'active' : ''}" onclick="goToDomainPage(${p})">${p}</button>`;
    } else if (p === domainCurrentPage - 3 || p === domainCurrentPage + 3) {
      pageButtonsHtml += `<span style="padding:0 4px; color:var(--muted);">…</span>`;
    }
  }

  container.innerHTML = `
    <div>Showing <strong>${startItem}–${endItem}</strong> of <strong>${totalItems}</strong> domains</div>
    <div class="pagination-controls">
      <button class="page-btn" ${domainCurrentPage === 1 ? 'disabled' : ''} onclick="goToDomainPage(${domainCurrentPage - 1})">« Prev</button>
      ${pageButtonsHtml}
      <button class="page-btn" ${domainCurrentPage === totalPages ? 'disabled' : ''} onclick="goToDomainPage(${domainCurrentPage + 1})">Next »</button>
    </div>
  `;
}

function goToDomainPage(p) {
  domainCurrentPage = p;
  renderDomains();
}
window.goToDomainPage = goToDomainPage;

// Separate group dropdowns:
// 1. groupSelect inside addDomainForm: for assigning the new domain to a specific group
// 2. groupFilterSelect above the domains list: for filtering the visible domains by group
function renderGroupSelect() {
  const sel = document.getElementById('groupSelect');
  if (sel) {
    const currentVal = sel.value;
    sel.innerHTML = `<option value="" disabled ${!currentVal ? 'selected' : ''}>Select group</option>` +
      allGroups.map(g => `<option value="${g.id}">${escapeHtml(g.name)}</option>`).join('');
    if (currentVal && allGroups.some(g => String(g.id) === String(currentVal))) {
      sel.value = currentVal;
    }
  }

  const filterSel = document.getElementById('groupFilterSelect');
  if (filterSel) {
    filterSel.innerHTML = `<option value="all">All groups</option>` +
      allGroups.map(g => `<option value="${g.id}">${escapeHtml(g.name)} (${g.domain_count})</option>`).join('');
    const stillExists = activeGroupFilter === 'all' || allGroups.some(g => g.id === activeGroupFilter);
    if (!stillExists) activeGroupFilter = 'all';
    filterSel.value = activeGroupFilter === 'all' ? 'all' : String(activeGroupFilter);
  }
}

const groupFilterEl = document.getElementById('groupFilterSelect');
if (groupFilterEl) {
  groupFilterEl.addEventListener('change', (e) => {
    activeGroupFilter = e.target.value === 'all' ? 'all' : Number(e.target.value);
    domainCurrentPage = 1;
    renderDomains();
  });
}

let isGuest = false;

function setupGuestUI(plans) {
  isGuest = true;
  window.isGuest = true;
  currentUser = null;
  window.currentUser = null;
  currentPlans = plans || currentPlans || {
    trial: {
      label: 'Free Trial (30 Days)',
      subtitle: 'Good for basic testing & evaluation',
      price: 0, originalPrice: 0, domainLimit: 5, recipientLimit: 1, criticalIntervalMinutes: 180, trialDays: 30,
      features: [
        '<strong>5</strong> domains monitored',
        'Daily SSL expiry checks',
        '<strong>1</strong> email alert recipient',
        '3-hour expiry alert intervals',
        'Let\'s Encrypt & self-signed cert generation with storage',
        'Status filters (warning/critical/healthy)',
        'Standard support'
      ]
    },
    micro: {
      label: 'Micro',
      subtitle: 'Good for personal projects & portfolios',
      price: 2, originalPrice: 4, domainLimit: 5, recipientLimit: 1, criticalIntervalMinutes: 180, badge: 'LIMITED TIME OFFER',
      features: [
        '<strong>5</strong> domains monitored',
        'Daily SSL expiry checks',
        '<strong>1</strong> email alert recipient',
        '3-hour expiry alert intervals',
        'Cert generator with storage',
        'Status filters & SSL tools',
        'Standard support'
      ]
    },
    starter: {
      label: 'Starter',
      subtitle: 'Good for early-stage startups & individual developers',
      price: 5, originalPrice: 10, domainLimit: 20, recipientLimit: 3, criticalIntervalMinutes: 120, badge: 'LIMITED TIME OFFER',
      features: [
        '<strong>20</strong> domains monitored',
        'Daily SSL expiry checks',
        'Up to <strong>3</strong> email recipients',
        '2-hour expiry alert intervals',
        'Cert generator with storage',
        'Status filters & SSL tools',
        'Enhanced support'
      ]
    },
    growth: {
      label: 'Growth',
      subtitle: 'Good for growing companies with multiple subdomains',
      price: 10, originalPrice: 0, domainLimit: 50, recipientLimit: 5, criticalIntervalMinutes: 60,
      features: [
        '<strong>50</strong> domains monitored',
        'Daily SSL expiry checks',
        'Up to <strong>5</strong> email recipients',
        '1-hour expiry alert intervals',
        'Cert generator with storage',
        'Status filters & SSL tools',
        'Enhanced support'
      ]
    },
    pro: {
      label: 'Pro',
      subtitle: 'Good for businesses with large web infrastructure',
      price: 20, originalPrice: 0, domainLimit: 100, recipientLimit: 10, criticalIntervalMinutes: 30,
      features: [
        '<strong>100</strong> domains monitored',
        'Daily SSL expiry checks',
        'Up to <strong>10</strong> email recipients',
        '30-min expiry alert intervals',
        'Cert generator with storage',
        'Status filters & SSL tools',
        'Premium support'
      ]
    },
    agency: {
      label: 'Agency',
      subtitle: 'Good for digital agencies & IT consultancies',
      price: 50, originalPrice: 0, domainLimit: 500, recipientLimit: 25, criticalIntervalMinutes: 10,
      features: [
        '<strong>500</strong> domains monitored',
        'Daily SSL expiry checks',
        'Up to <strong>25</strong> email recipients',
        '10-min expiry alert intervals',
        'Cert generator with storage',
        'Status filters & SSL tools',
        'Dedicated support'
      ]
    },
    enterprise: {
      label: 'Enterprise',
      subtitle: 'Good for large enterprise portfolios & custom SLAs',
      price: 0, originalPrice: 0, domainLimit: 500, recipientLimit: 50, criticalIntervalMinutes: 10, enterprise: true, custom: true,
      features: [
        '<strong>500+</strong> domains monitored',
        'Daily SSL expiry checks',
        'Up to <strong>50+</strong> email recipients',
        'Custom expiry alert intervals',
        'Cert generator with storage',
        'Status filters & SSL tools',
        'Dedicated account manager & SLA'
      ]
    }
  };
  if (!plans) {
    fetch('/api/billing/plans').then(r => r.json()).then(d => {
      if (d && d.plans) currentPlans = d.plans;
    }).catch(() => {});
  }

  const upgradeLink = document.getElementById('upgradeLink');
  if (upgradeLink) upgradeLink.textContent = 'Plans';

  const accountLink = document.getElementById('accountLink');
  if (accountLink) accountLink.style.display = 'none';

  const adminLink = document.getElementById('adminLink');
  if (adminLink) adminLink.style.display = 'none';

  const logoutLink = document.getElementById('logoutLink');
  if (logoutLink) logoutLink.style.display = 'none';

  const userPlanWidget = document.getElementById('userPlanWidget');
  if (userPlanWidget) userPlanWidget.style.display = 'none';

  const guestAuthWidget = document.getElementById('guestAuthWidget');
  if (guestAuthWidget) guestAuthWidget.style.display = 'block';

  const sidebarPlanBadge = document.getElementById('sidebarPlanBadge');
  const sidebarPlanBadgeText = document.getElementById('sidebarPlanBadgeText');
  if (sidebarPlanBadge && sidebarPlanBadgeText) {
    sidebarPlanBadgeText.textContent = 'Guest Mode';
    sidebarPlanBadge.className = 'sidebar-plan-pill plan-pill-guest';
    sidebarPlanBadge.style.display = 'inline-flex';
  }

  const banner = document.getElementById('billingPausedBanner');
  if (banner) banner.style.display = 'none';

  const planTrialExpiry = document.getElementById('planTrialExpiry');
  if (planTrialExpiry) planTrialExpiry.style.display = 'none';

  const trialExpiredBanner = document.getElementById('trialExpiredBanner');
  if (trialExpiredBanner) trialExpiredBanner.style.display = 'none';
}

function setupAuthenticatedUI(data) {
  isGuest = false;
  window.isGuest = false;
  currentUser = data.user;
  window.currentUser = data.user;
  currentPlans = data.plans;

  const upgradeLink = document.getElementById('upgradeLink');
  if (upgradeLink) upgradeLink.textContent = 'Upgrade plan';

  const accountLink = document.getElementById('accountLink');
  if (accountLink) accountLink.style.display = '';

  const adminLink = document.getElementById('adminLink');
  if (adminLink) adminLink.style.display = data.user.is_admin ? '' : 'none';

  const logoutLink = document.getElementById('logoutLink');
  if (logoutLink) logoutLink.style.display = '';

  const userPlanWidget = document.getElementById('userPlanWidget');
  if (userPlanWidget) userPlanWidget.style.display = 'block';

  const guestAuthWidget = document.getElementById('guestAuthWidget');
  if (guestAuthWidget) guestAuthWidget.style.display = 'none';

  const rawPlan = data.user.plan || 'trial';
  const planLabel = (data.plans && data.plans[rawPlan] && data.plans[rawPlan].label) || (rawPlan === 'trial' ? 'Free Trial' : rawPlan);
  const isTrial = rawPlan === 'trial';
  const isTrialExpired = isTrial && (data.user.is_trial_expired || (data.user.trial_days_left !== null && data.user.trial_days_left <= 0));

  const sidebarPlanBadge = document.getElementById('sidebarPlanBadge');
  const sidebarPlanBadgeText = document.getElementById('sidebarPlanBadgeText');
  if (sidebarPlanBadge && sidebarPlanBadgeText) {
    if (isTrial) {
      const trialText = data.user.trial_expires_text || (data.user.trial_days_left != null ? `Free trial expires in ${data.user.trial_days_left} days` : 'Free Trial');
      sidebarPlanBadgeText.textContent = trialText;
      sidebarPlanBadge.className = `sidebar-plan-pill plan-pill-free${isTrialExpired ? ' trial-expired' : ''}`;
      sidebarPlanBadge.title = trialText;
    } else {
      sidebarPlanBadgeText.textContent = planLabel;
      const planClass = `plan-pill-${rawPlan}`;
      sidebarPlanBadge.className = `sidebar-plan-pill ${planClass}`;
      sidebarPlanBadge.title = planLabel;
    }
    sidebarPlanBadge.style.display = 'inline-flex';
  }

  document.getElementById('planName').textContent = isTrial ? 'Free Trial' : planLabel;

  const planTrialExpiry = document.getElementById('planTrialExpiry');
  if (planTrialExpiry) {
    if (isTrial && data.user.trial_expires_text) {
      planTrialExpiry.textContent = data.user.trial_expires_text;
      planTrialExpiry.style.display = 'block';
      if (isTrialExpired) {
        planTrialExpiry.style.color = '#F87171';
      } else {
        planTrialExpiry.style.color = '#2DD4BF';
      }
    } else {
      planTrialExpiry.style.display = 'none';
    }
  }

  const planWidgetUpgradeBtn = document.getElementById('planWidgetUpgradeBtn');
  const planWidgetUpgradeLabel = document.getElementById('planWidgetUpgradeLabel');
  if (planWidgetUpgradeBtn) {
    if (isTrial) {
      planWidgetUpgradeBtn.style.display = 'inline-flex';
      if (planWidgetUpgradeLabel) {
        planWidgetUpgradeLabel.textContent = isTrialExpired ? 'Upgrade to Reactivate' : 'Upgrade Plan';
      }
      if (isTrialExpired) {
        planWidgetUpgradeBtn.classList.add('is-urgent');
      } else {
        planWidgetUpgradeBtn.classList.remove('is-urgent');
      }
    } else if (rawPlan === 'unlimited' || rawPlan === 'enterprise') {
      planWidgetUpgradeBtn.style.display = 'none';
    } else {
      planWidgetUpgradeBtn.style.display = 'inline-flex';
      if (planWidgetUpgradeLabel) planWidgetUpgradeLabel.textContent = 'Upgrade Plan';
      planWidgetUpgradeBtn.classList.remove('is-urgent');
    }
  }

  const banner = document.getElementById('billingPausedBanner');
  const isPausedPaidPlan = data.user.plan !== 'trial' && data.user.billing_status !== 'active';
  if (banner) banner.style.display = isPausedPaidPlan ? 'flex' : 'none';

  const trialExpiredBanner = document.getElementById('trialExpiredBanner');
  if (trialExpiredBanner) {
    trialExpiredBanner.style.display = isTrialExpired ? 'flex' : 'none';
  }
}

// ---------------- Data loading ----------------
async function loadMe() {
  try {
    const res = await fetch('/api/auth/me');
    if (res.status === 401) {
      setupGuestUI();
      if (typeof handleHashRoute === 'function') {
        handleHashRoute();
      }
      return null;
    }
    const data = await res.json();
    setupAuthenticatedUI(data);
    if (typeof handleHashRoute === 'function') {
      handleHashRoute();
    }
    return data;
  } catch (err) {
    setupGuestUI();
    if (typeof handleHashRoute === 'function') {
      handleHashRoute();
    }
    return null;
  }
}

async function loadGroups() {
  if (isGuest) return;
  try {
    const res = await fetch('/api/groups');
    if (res.status === 401) return;
    const data = await res.json();
    allGroups = data.groups;
    renderGroupSelect();
    renderDomains();
  } catch (_) {}
}

async function loadDomains() {
  if (isGuest) {
    renderDomains();
    return;
  }
  try {
    const res = await fetch('/api/domains');
    if (res.status === 401) return;
    const data = await res.json();
    allDomains = data.domains;
    const isUnlimited = data.limit >= 100000;
    document.getElementById('planUsage').textContent =
      isUnlimited ? `${allDomains.length} domains (unlimited)` : `${allDomains.length} / ${data.limit} domains`;
    const pct = isUnlimited ? 8 : Math.min(100, Math.round((allDomains.length / data.limit) * 100));
    document.getElementById('planUsageBar').style.width = pct + '%';
    renderDomains();
    if (typeof loadDomainAlertEmails === 'function') {
      loadDomainAlertEmails();
    }
  } catch (_) {}
}

// ---------------- Stat filter clicks ----------------
document.querySelectorAll('.stat-card').forEach(card => {
  card.addEventListener('click', () => {
    activeFilter = card.dataset.filter;
    domainCurrentPage = 1;
    renderDomains();
  });
});
document.getElementById('clearFilterBtn')?.addEventListener('click', () => {
  activeFilter = 'all';
  domainCurrentPage = 1;
  renderDomains();
});

// ---------------- Groups: create inline ----------------
document.getElementById('newGroupToggle').addEventListener('click', () => {
  if (isGuest) {
    if (typeof showAuthModal === 'function') {
      showAuthModal('login', 'Sign in or register to create domain groups');
    }
    return;
  }
  const row = document.getElementById('newGroupRow');
  row.style.display = row.style.display === 'none' ? 'flex' : 'none';
  if (row.style.display === 'flex') document.getElementById('newGroupInput').focus();
});

document.getElementById('createGroupBtn').addEventListener('click', async () => {
  if (isGuest) {
    if (typeof showAuthModal === 'function') {
      showAuthModal('login', 'Sign in or register to create domain groups');
    }
    return;
  }
  const input = document.getElementById('newGroupInput');
  const name = input.value.trim();
  if (!name) return;
  try {
    const res = await fetch('/api/groups', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    input.value = '';
    document.getElementById('newGroupRow').style.display = 'none';
    await loadGroups();
    document.getElementById('groupSelect').value = data.group.id;
    toast(`Group "${name}" created.`);
  } catch (err) {
    toast(err.message, true);
  }
});

// ---------------- Add domain ----------------
document.getElementById('addDomainForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (isGuest) {
    if (typeof showAuthModal === 'function') {
      showAuthModal('login', 'Sign in to add and monitor domains');
    }
    return;
  }
  const input = document.getElementById('hostnameInput');
  const hostname = input.value.trim();
  const selVal = document.getElementById('groupSelect').value;
  if (!selVal || selVal === 'all') {
    toast('Please select or create a group for this domain.', true);
    document.getElementById('groupSelect').focus();
    return;
  }
  const groupId = Number(selVal);
  if (!hostname) return;
  try {
    const res = await fetch('/api/domains', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hostname, group_id: groupId })
    });
    if (res.status === 401) {
      if (typeof showAuthModal === 'function') {
        showAuthModal('login', 'Sign in to add and monitor domains');
      }
      return;
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    input.value = '';
    toast(`Added ${hostname} — checking now.`);
    loadDomains();
    loadGroups();
  } catch (err) {
    toast(err.message, true);
  }
});

// ---------------- Internal certificates (pasted PEM) ----------------
const internalPanel = document.getElementById('internalCertPanel');

document.getElementById('internalCertToggle').addEventListener('click', () => {
  if (isGuest) {
    if (typeof showAuthModal === 'function') {
      showAuthModal('login', 'Sign in to add and monitor internal certificates');
    }
    return;
  }
  const showing = internalPanel.style.display !== 'none';
  internalPanel.style.display = showing ? 'none' : 'block';
  if (!showing) document.getElementById('internalLabelInput').focus();
});

document.getElementById('cancelInternalCertBtn').addEventListener('click', () => {
  internalPanel.style.display = 'none';
  document.getElementById('internalPemInput').value = '';
  document.getElementById('internalLabelInput').value = '';
});

document.getElementById('saveInternalCertBtn').addEventListener('click', async (e) => {
  if (isGuest) {
    if (typeof showAuthModal === 'function') {
      showAuthModal('login', 'Sign in or register to add internal certificates');
    }
    return;
  }
  const btn = e.target;
  const pem = document.getElementById('internalPemInput').value.trim();
  const label = document.getElementById('internalLabelInput').value.trim();
  const selVal = document.getElementById('groupSelect').value;
  if (!selVal || selVal === 'all') {
    btn.disabled = false;
    btn.textContent = 'Save & Monitor Certificate';
    toast('Please select or create a group for this certificate.', true);
    document.getElementById('groupSelect').focus();
    return;
  }
  const groupId = Number(selVal);

  if (!pem) return toast('Paste a certificate first.', true);

  btn.disabled = true;
  btn.textContent = 'Checking…';
  try {
    const res = await fetch('/api/domains/internal', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pem, label, group_id: groupId })
    });
    if (res.status === 401) {
      if (typeof showAuthModal === 'function') {
        showAuthModal('login', 'Sign in to add internal certificates');
      }
      return;
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    document.getElementById('internalPemInput').value = '';
    document.getElementById('internalLabelInput').value = '';
    internalPanel.style.display = 'none';
    toast(`Added ${data.domain.hostname} — now monitored.`);
    loadDomains();
    loadGroups();
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Add certificate';
  }
});

// ---------------- Row actions ----------------
document.getElementById('domainList').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  if (isGuest) {
    if (typeof showAuthModal === 'function') {
      showAuthModal('login', 'Sign in or register to manage monitored domains');
    }
    return;
  }
  const row = btn.closest('.domain-row');
  const id = row.dataset.id;

  if (btn.dataset.action === 'delete') {
    if (!confirm('Stop monitoring this domain?')) return;
    await fetch(`/api/domains/${id}`, { method: 'DELETE' });
    toast('Domain removed.');
    loadDomains();
    loadGroups();
  }

  if (btn.dataset.action === 'check') {
    btn.textContent = 'Checking…';
    btn.disabled = true;
    try {
      await fetch(`/api/domains/${id}/check-now`, { method: 'POST' });
      toast('Certificate re-checked.');
    } finally {
      loadDomains();
    }
  }

  if (btn.dataset.action === 'ack') {
    btn.textContent = 'Acknowledging…';
    btn.disabled = true;
    try {
      await fetch(`/api/domains/${id}/acknowledge`, { method: 'POST' });
      toast('Alerts paused for this domain until its status changes.');
    } finally {
      loadDomains();
    }
  }

  if (btn.dataset.action === 'update-cert') {
    const domain = allDomains.find(d => String(d.id) === String(id));
    if (!domain) return;
    openEditInternalCertModal(domain);
  }
});

// ---------------- Internal Certificate Update Modal ----------------
function openEditInternalCertModal(domain) {
  const modal = document.getElementById('editInternalCertModal');
  if (!modal) return;
  document.getElementById('editInternalDomainId').value = domain.id;
  document.getElementById('editInternalModalTitle').textContent = `Update Certificate: ${domain.hostname}`;
  document.getElementById('editInternalLabel').value = domain.label || '';
  document.getElementById('editInternalPem').value = domain.pem || '';
  const errBox = document.getElementById('editInternalError');
  if (errBox) { errBox.style.display = 'none'; errBox.textContent = ''; }
  modal.style.display = 'flex';
  document.getElementById('editInternalPem').focus();
}

function closeEditInternalCertModal() {
  const modal = document.getElementById('editInternalCertModal');
  if (modal) modal.style.display = 'none';
}
window.closeEditInternalCertModal = closeEditInternalCertModal;

document.getElementById('saveRenewedCertBtn')?.addEventListener('click', async () => {
  const id = document.getElementById('editInternalDomainId').value;
  const label = document.getElementById('editInternalLabel').value.trim();
  const pem = document.getElementById('editInternalPem').value.trim();
  const errBox = document.getElementById('editInternalError');
  const btn = document.getElementById('saveRenewedCertBtn');

  if (errBox) { errBox.style.display = 'none'; errBox.textContent = ''; }
  if (!pem) {
    if (errBox) { errBox.textContent = 'Please paste the renewed certificate (PEM).'; errBox.style.display = 'block'; }
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Updating…';

  try {
    const res = await fetch(`/api/domains/${id}/internal`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pem, label })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to update certificate.');

    closeEditInternalCertModal();
    toast(`Certificate for ${data.domain.hostname} updated and verified.`);
    loadDomains();
  } catch (err) {
    if (errBox) {
      errBox.textContent = err.message;
      errBox.style.display = 'block';
    } else {
      toast(err.message, true);
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save & Update Certificate';
  }
});

// ---------------- Sidebar / logout / upgrade ----------------
document.getElementById('logoutLink').addEventListener('click', async (e) => {
  e.preventDefault();
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/login.html';
});

const upgradeModal = document.getElementById('upgradeModal');

function openUpgradeModal() {
  const plansEl = document.getElementById('modalPlans');
  const headTitle = document.querySelector('#upgradeModal .modal-head h2');
  if (headTitle) {
    headTitle.textContent = isGuest ? 'Choose your plan' : 'Upgrade your plan';
  }
  const entries = Object.entries(currentPlans || {}).filter(([id]) => id !== 'enterprise' && id !== 'unlimited');

  const tierRanks = { trial: 1, micro: 2, starter: 3, growth: 4, pro: 5, agency: 6, enterprise: 7, unlimited: 7 };
  const userRank = currentUser ? (tierRanks[currentUser.plan] || 1) : 0;

  const plansHtml = entries.map(([id, plan]) => {
    const isCurrentPlan = currentUser && (currentUser.plan === id || (id === 'trial' && (!currentUser.plan || currentUser.plan === 'trial')));
    const isCurrentAndPaid = isCurrentPlan && (id === 'trial' || currentUser.billing_status === 'active');
    const isCurrentButHalted = isCurrentPlan && currentUser.billing_status !== 'active' && id !== 'trial';
    const thisRank = tierRanks[id] || 1;
    const isLowerTier = currentUser && !isGuest && (userRank > thisRank);

    let badgeHtml = '';
    if (id === 'micro' || id === 'starter' || plan.badge) {
      const badgeText = plan.badge || 'LIMITED TIME OFFER';
      badgeHtml = `<span class="tag" style="background:#F59E0B; color:#0A2740; font-weight:800; font-size:11px; padding:3px 8px; border-radius:6px; display:inline-block; margin-bottom:8px;">${badgeText}</span>`;
    } else if (id === 'trial') {
      badgeHtml = `<span class="tag" style="background:#0284C7; color:#fff; font-weight:700; font-size:11px; padding:3px 8px; border-radius:6px; display:inline-block; margin-bottom:8px;">30-DAY TRIAL</span>`;
    }

    let priceDisplay = '';
    if (id === 'trial') {
      priceDisplay = `
        <div class="mp-price">
          <div class="price-active-container">
            <span class="price-current">$0</span><span class="mp-period">/30 days</span>
          </div>
        </div>`;
    } else if (id === 'micro' || plan.originalPrice) {
      const orig = plan.originalPrice || 4;
      const curr = plan.price || 2;
      const discountPct = Math.round((1 - curr / orig) * 100);
      priceDisplay = `
        <div class="mp-price">
          <div class="price-cross-container">
            <span class="price-original-cross">$${orig}</span>
            <span class="discount-badge-pill" style="background:#FEF3C7; color:#B45309; border:1px solid #FCD34D;">SAVE ${discountPct}%</span>
          </div>
          <div class="price-active-container">
            <span class="price-current">$${curr}</span><span class="mp-period">/month</span>
          </div>
        </div>`;
    } else {
      priceDisplay = `
        <div class="mp-price">
          <div class="price-active-container">
            <span class="price-current">$${plan.price}</span><span class="mp-period">/month</span>
          </div>
        </div>`;
    }

    let actionCta = '';
    if (isGuest) {
      const guestText = id === 'trial' ? 'Start 30-Day Free Trial' : `Get started with ${plan.label}`;
      actionCta = `<button class="btn btn-accent btn-block" data-plan="${id}">${guestText}</button>`;
    } else if (isCurrentPlan) {
      if (isCurrentButHalted) {
        actionCta = `<button class="btn btn-accent btn-block" data-plan="${id}">Renew ${plan.label}</button>`;
      } else {
        const trialExpiryNote = (id === 'trial' && currentUser && currentUser.trial_expires_text)
          ? `<div style="font-size:11px; margin-top:4px; opacity:0.85;">${currentUser.trial_expires_text}</div>`
          : '';
        actionCta = `<div class="mp-current-badge">✓ Your current plan${trialExpiryNote}</div>`;
      }
    } else if (isLowerTier) {
      actionCta = `<div class="mp-included-badge">Included with account</div>`;
    } else {
      actionCta = `<button class="btn btn-accent btn-block" data-plan="${id}">Choose ${plan.label}</button>`;
    }

    const detailCopy = id === 'trial'
      ? `<strong>5</strong> domains monitored · <strong>1</strong> recipient<br>30-day trial · Alerts every <strong>3h</strong> (critical)`
      : `<strong>${plan.domainLimit}</strong> domain${plan.domainLimit === 1 ? '' : 's'} · <strong>${plan.recipientLimit || 1}</strong> recipient${(plan.recipientLimit || 1) === 1 ? '' : 's'}<br>Alerts every <strong>${plan.criticalIntervalMinutes >= 60 ? (plan.criticalIntervalMinutes / 60) + 'h' : plan.criticalIntervalMinutes + 'm'}</strong> (critical)`;

    const subtitleHtml = plan.subtitle ? `<div class="mp-subtitle">(${plan.subtitle})</div>` : '';
    const featuresHtml = (plan.features && plan.features.length)
      ? `<ul>${plan.features.map(f => `<li>${f}</li>`).join('')}</ul>`
      : `<div class="mp-detail">${detailCopy}</div>`;

    return `
      <div class="modal-plan ${isCurrentPlan ? 'current' : ''}">
        ${badgeHtml}
        <div class="mp-name">${plan.label}</div>
        ${subtitleHtml}
        ${priceDisplay}
        ${featuresHtml}
        ${actionCta}
      </div>`;
  }).join('');

  plansEl.innerHTML = plansHtml;

  // Modal carousel navigation controls
  const modalTrack = document.getElementById('modalPlans');
  const modalPrevBtn = document.getElementById('modalPlanPrevBtn');
  const modalNextBtn = document.getElementById('modalPlanNextBtn');
  const modalDots = document.querySelectorAll('#modalNavDots .modal-dot');

  function updateModalCarousel() {
    if (!modalTrack) return;
    const maxScroll = Math.max(0, modalTrack.scrollWidth - modalTrack.clientWidth);
    const scrollLeft = modalTrack.scrollLeft;
    if (modalPrevBtn) modalPrevBtn.disabled = scrollLeft <= 10;
    if (modalNextBtn) modalNextBtn.disabled = scrollLeft >= maxScroll - 10;
    if (modalDots.length >= 2) {
      const pageIdx = (maxScroll > 0 && scrollLeft > maxScroll * 0.4) ? 1 : 0;
      modalDots.forEach((dot, idx) => dot.classList.toggle('active', idx === pageIdx));
    }
  }

  if (modalPrevBtn && !modalPrevBtn._wired) {
    modalPrevBtn._wired = true;
    modalPrevBtn.addEventListener('click', () => {
      const card = modalTrack.querySelector('.modal-plan');
      const scrollAmount = card ? (card.offsetWidth + 16) * 3 : modalTrack.clientWidth;
      modalTrack.scrollBy({ left: -scrollAmount, behavior: 'smooth' });
    });
  }
  if (modalNextBtn && !modalNextBtn._wired) {
    modalNextBtn._wired = true;
    modalNextBtn.addEventListener('click', () => {
      const card = modalTrack.querySelector('.modal-plan');
      const scrollAmount = card ? (card.offsetWidth + 16) * 3 : modalTrack.clientWidth;
      modalTrack.scrollBy({ left: scrollAmount, behavior: 'smooth' });
    });
  }
  if (modalTrack && !modalTrack._wired) {
    modalTrack._wired = true;
    modalTrack.addEventListener('scroll', updateModalCarousel, { passive: true });
  }
  modalDots.forEach(dot => {
    if (!dot._wired) {
      dot._wired = true;
      dot.addEventListener('click', () => {
        const page = parseInt(dot.dataset.page, 10);
        const maxScroll = Math.max(0, modalTrack.scrollWidth - modalTrack.clientWidth);
        modalTrack.scrollTo({ left: page === 0 ? 0 : maxScroll, behavior: 'smooth' });
      });
    }
  });

  upgradeModal.classList.add('visible');
  setTimeout(updateModalCarousel, 80);
}
function closeUpgradeModal() { upgradeModal.classList.remove('visible'); }

document.getElementById('upgradeLink').addEventListener('click', (e) => { e.preventDefault(); openUpgradeModal(); });
document.getElementById('planWidgetUpgradeBtn')?.addEventListener('click', (e) => { e.preventDefault(); openUpgradeModal(); });
document.getElementById('renewFromBannerBtn')?.addEventListener('click', openUpgradeModal);
document.getElementById('modalClose').addEventListener('click', closeUpgradeModal);
upgradeModal.addEventListener('click', (e) => { if (e.target === upgradeModal) closeUpgradeModal(); });

// Razorpay checkout: create a subscription server-side, open the widget,
// then verify the resulting payment before the plan is actually applied.
document.getElementById('modalPlans').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-plan]');
  if (!btn) return;
  const plan = btn.dataset.plan;

  if (isGuest) {
    closeUpgradeModal();
    const planName = currentPlans?.[plan]?.label || plan;
    showAuthModal('signup', `Create a free account to choose the ${planName} plan`);
    return;
  }

  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Starting checkout…';

  try {
    // 1. Try Dodo Payments first
    const dodoRes = await fetch('/api/billing/dodo/checkout', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan, return_path: window.location.pathname })
    });
    if (dodoRes.status === 401) {
      showAuthModal('login', 'Your session expired. Please sign in again.');
      btn.disabled = false;
      btn.textContent = originalLabel;
      return;
    }
    const dodoData = await dodoRes.json().catch(() => ({}));
    if (dodoRes.ok && dodoData.url) {
      window.location.href = dodoData.url;
      return;
    }

    // 2. If Dodo is not configured (501), fallback to Razorpay
    if (dodoRes.status === 501) {
      const subRes = await fetch('/api/billing/razorpay/subscribe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan })
      });
      const subData = await subRes.json();
      if (subRes.status === 401) {
        // Session died (expired, or the account no longer exists) — show auth modal
        showAuthModal('login', 'Your session expired. Please sign in again.');
        return;
      }
      if (!subRes.ok) throw new Error(subData.error);

      if (typeof Razorpay === 'undefined') {
        throw new Error('Payment widget failed to load — check your internet connection and try again.');
      }

      const rzp = new Razorpay({
        key: subData.key,
        subscription_id: subData.subscription_id,
        name: 'HariSree SSL Alerts',
        description: `${currentPlans[plan].label} plan — $${currentPlans[plan].price}/month`,
        theme: { color: '#0A2740' },
        handler: async function (response) {
          try {
            const verifyRes = await fetch('/api/billing/razorpay/verify', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ...response, plan })
            });
            const verifyData = await verifyRes.json();
            if (!verifyRes.ok) throw new Error(verifyData.error);
            toast('Payment successful — plan upgraded!');
            closeUpgradeModal();
            loadMe();
            loadDomains();
          } catch (err) {
            toast(err.message, true);
          }
        },
        modal: {
          ondismiss: function () {
            btn.disabled = false;
            btn.textContent = originalLabel;
          }
        }
      });
      rzp.open();
    } else {
      throw new Error(dodoData.error || 'Failed to start checkout');
    }
  } catch (err) {
    toast(err.message, true);
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
});

// ---------------- Guest Auth Modal ----------------
const authModal = document.getElementById('authModal');
const authModalContext = document.getElementById('authModalContext');
const authModalError = document.getElementById('authModalError');
const authModalLoginForm = document.getElementById('authModalLoginForm');
const authModalSignupForm = document.getElementById('authModalSignupForm');

function showAuthModal(tab = 'login', contextMessage = '') {
  if (!authModal) return;
  if (contextMessage) {
    authModalContext.textContent = contextMessage;
    authModalContext.style.display = 'flex';
  } else {
    authModalContext.style.display = 'none';
  }
  switchAuthModalTab(tab);
  authModal.style.display = 'flex';
}

function closeAuthModal() {
  if (!authModal) return;
  authModal.style.display = 'none';
  if (authModalError) {
    authModalError.textContent = '';
    authModalError.style.display = 'none';
  }
}

function switchAuthModalTab(tab) {
  if (authModalError) {
    authModalError.textContent = '';
    authModalError.style.display = 'none';
  }
  const isLogin = tab === 'login';
  const isSignup = tab === 'signup';
  const isOtp = tab === 'otp';

  const tabLogin = document.getElementById('authTabLogin');
  const tabSignup = document.getElementById('authTabSignup');
  const title = document.getElementById('authModalTitle');
  const tabsWrap = document.querySelector('.auth-modal-tabs');
  const authModalOtpForm = document.getElementById('authModalOtpForm');

  if (tabsWrap) tabsWrap.style.display = isOtp ? 'none' : 'flex';
  if (tabLogin) tabLogin.classList.toggle('active', isLogin);
  if (tabSignup) tabSignup.classList.toggle('active', isSignup);

  if (title) {
    if (isOtp) title.textContent = 'Verify your email';
    else title.textContent = isLogin ? 'Sign in to SSL Alerts' : 'Create your account';
  }

  if (authModalLoginForm) authModalLoginForm.style.display = isLogin ? 'block' : 'none';
  if (authModalSignupForm) authModalSignupForm.style.display = isSignup ? 'block' : 'none';
  if (authModalOtpForm) authModalOtpForm.style.display = isOtp ? 'block' : 'none';

  if (isLogin) {
    document.getElementById('authLoginEmail')?.focus();
  } else if (isSignup) {
    document.getElementById('authSignupName')?.focus();
  } else if (isOtp) {
    document.getElementById('authModalOtpInput')?.focus();
  }
}

let modalPendingEmail = '';
let modalResendTimer = null;
let modalResendCountdown = 0;

function startModalResendCooldown(seconds = 60) {
  const btn = document.getElementById('authModalResendOtpBtn');
  if (!btn) return;
  modalResendCountdown = seconds;
  btn.disabled = true;
  btn.style.opacity = '0.6';
  btn.style.cursor = 'not-allowed';

  if (modalResendTimer) clearInterval(modalResendTimer);
  modalResendTimer = setInterval(() => {
    modalResendCountdown--;
    if (modalResendCountdown <= 0) {
      clearInterval(modalResendTimer);
      btn.disabled = false;
      btn.style.opacity = '1';
      btn.style.cursor = 'pointer';
      btn.textContent = 'Resend code';
    } else {
      btn.textContent = `Resend code (${modalResendCountdown}s)`;
    }
  }, 1000);
}

if (authModal) {
  authModal.addEventListener('click', (e) => {
    if (e.target === authModal) closeAuthModal();
  });
}

authModalLoginForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('authLoginEmail')?.value.trim();
  const password = document.getElementById('authLoginPassword')?.value;
  const submitBtn = document.getElementById('authLoginSubmitBtn');
  if (!email || !password) return;

  submitBtn.disabled = true;
  submitBtn.textContent = 'Logging in…';
  if (authModalError) authModalError.style.display = 'none';

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if (!res.ok) {
      if (data.requireOtp && data.email) {
        modalPendingEmail = data.email;
        const emailEl = document.getElementById('authModalOtpEmail');
        if (emailEl) emailEl.textContent = data.email;
        switchAuthModalTab('otp');
        startModalResendCooldown(60);
        return;
      }
      throw new Error(data.error || 'Login failed');
    }

    closeAuthModal();
    toast('Welcome back!');
    await loadMe();
    await loadGroups();
    await loadDomains();
    const dest = window.pendingAuthDestination;
    window.pendingAuthDestination = null;
    if (dest === 'sslTools' && typeof showSSLTools === 'function') {
      showSSLTools();
    } else if (dest === 'certificates' && typeof showCertificates === 'function') {
      showCertificates();
    } else if (dest === 'alertEmails' && typeof showAlertEmails === 'function') {
      showAlertEmails();
    } else if (dest === 'dnsLookup' && typeof showDNSLookup === 'function') {
      showDNSLookup();
    } else if (typeof showDomains === 'function') {
      showDomains();
    }
  } catch (err) {
    if (authModalError) {
      authModalError.textContent = err.message;
      authModalError.style.display = 'block';
    } else {
      toast(err.message, true);
    }
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Log in';
  }
});

authModalSignupForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('authSignupName')?.value.trim();
  const email = document.getElementById('authSignupEmail')?.value.trim();
  const password = document.getElementById('authSignupPassword')?.value;
  const confirmPassword = document.getElementById('authSignupConfirmPassword')?.value;
  const submitBtn = document.getElementById('authSignupSubmitBtn');
  if (!name || !email || !password) return;

  if (password !== confirmPassword) {
    if (authModalError) {
      authModalError.textContent = 'Passwords do not match. Please re-enter.';
      authModalError.style.display = 'block';
    }
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = 'Sending code…';
  if (authModalError) authModalError.style.display = 'none';

  try {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password, confirmPassword })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Signup failed');

    if (data.requireOtp) {
      modalPendingEmail = email;
      const emailEl = document.getElementById('authModalOtpEmail');
      if (emailEl) emailEl.textContent = email;
      switchAuthModalTab('otp');
      startModalResendCooldown(60);
    } else {
      closeAuthModal();
      toast('Account created! Welcome to SSL Alerts.');
      await loadMe();
      await loadGroups();
      await loadDomains();
    }
  } catch (err) {
    if (authModalError) {
      authModalError.textContent = err.message;
      authModalError.style.display = 'block';
    } else {
      toast(err.message, true);
    }
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Create free account';
  }
});

document.getElementById('authModalOtpForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const otp = document.getElementById('authModalOtpInput')?.value.trim();
  const submitBtn = document.getElementById('authModalOtpSubmitBtn');
  if (!otp || otp.length !== 6) {
    if (authModalError) {
      authModalError.textContent = 'Please enter the full 6-digit verification code.';
      authModalError.style.display = 'block';
    }
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = 'Verifying…';
  if (authModalError) authModalError.style.display = 'none';

  try {
    const res = await fetch('/api/auth/verify-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: modalPendingEmail, otp })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Verification failed');

    closeAuthModal();
    toast('Email verified! Welcome to SSL Alerts.');
    await loadMe();
    await loadGroups();
    await loadDomains();

    const dest = window.pendingAuthDestination;
    window.pendingAuthDestination = null;
    if (dest === 'sslTools' && typeof showSSLTools === 'function') {
      showSSLTools();
    } else if (dest === 'certificates' && typeof showCertificates === 'function') {
      showCertificates();
    } else if (dest === 'alertEmails' && typeof showAlertEmails === 'function') {
      showAlertEmails();
    } else if (dest === 'dnsLookup' && typeof showDNSLookup === 'function') {
      showDNSLookup();
    } else if (typeof showDomains === 'function') {
      showDomains();
    }
  } catch (err) {
    if (authModalError) {
      authModalError.textContent = err.message;
      authModalError.style.display = 'block';
    } else {
      toast(err.message, true);
    }
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Verify & Activate';
  }
});

document.getElementById('authModalResendOtpBtn')?.addEventListener('click', async () => {
  if (modalResendCountdown > 0) return;
  if (!modalPendingEmail) return;

  if (authModalError) authModalError.style.display = 'none';
  try {
    const res = await fetch('/api/auth/resend-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: modalPendingEmail })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to resend code');
    toast('New verification code sent to your email.');
    startModalResendCooldown(60);
  } catch (err) {
    if (authModalError) {
      authModalError.textContent = err.message;
      authModalError.style.display = 'block';
    }
  }
});

window.showAuthModal = showAuthModal;
window.closeAuthModal = closeAuthModal;
window.switchAuthModalTab = switchAuthModalTab;
window.openUpgradeModal = openUpgradeModal;
window.closeUpgradeModal = closeUpgradeModal;
window.loadMe = loadMe;
window.loadDomains = loadDomains;
window.loadGroups = loadGroups;

// ---------------- Mobile hamburger nav ----------------
const sidebar = document.getElementById('sidebar');
const sidebarOverlay = document.getElementById('sidebarOverlay');
function openSidebar() { sidebar.classList.add('open'); sidebarOverlay.classList.add('visible'); }
function closeSidebar() { sidebar.classList.remove('open'); sidebarOverlay.classList.remove('visible'); }
document.getElementById('hamburgerBtn')?.addEventListener('click', openSidebar);
sidebarOverlay.addEventListener('click', closeSidebar);
sidebar.querySelectorAll('nav a').forEach(a => a.addEventListener('click', closeSidebar));

// ---------------- Init ----------------
// Check for redirect from payment provider (Dodo Payments / Stripe)
const urlParams = new URLSearchParams(window.location.search);
if (urlParams.get('payment') === 'success') {
  const planParam = urlParams.get('plan');
  const subIdParam = urlParams.get('subscription_id');
  const planName = planParam ? (currentPlans?.[planParam]?.label || planParam) : '';

  if (subIdParam) {
    fetch('/api/billing/dodo/sync-subscription', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription_id: subIdParam, plan: planParam })
    }).finally(() => {
      loadMe();
      loadDomains();
    });
  }

  toast(planName ? `Payment successful! Upgraded to ${planName} plan.` : 'Payment successful — plan upgraded!');
  window.history.replaceState({}, document.title, window.location.pathname);
}

loadMe();
loadGroups();
loadDomains();
if (typeof loadDomainAlertEmails === 'function') {
  loadDomainAlertEmails();
}
window.addEventListener('load', () => {
  if (typeof loadDomainAlertEmails === 'function') {
    loadDomainAlertEmails();
  }
});
setInterval(loadDomains, 30000); // keep statuses fresh without a manual refresh
