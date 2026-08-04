const awardFormCard = document.querySelector('#awardFormCard');
const awardForm = document.querySelector('#awardForm');
const awardsList = document.querySelector('#awardsList');
const formMessage = document.querySelector('#formMessage');
const toast = document.querySelector('#toast');
const asOfInput = document.querySelector('#vestingAsOf');
const vestingEvents = document.querySelector('#vestingEvents');
let savedAwards = [];
let savedLots = [];
let editingAwardId = null;
let chartMode = 'cumulative';

const awardNames = {
  ISO: 'Incentive stock option',
  NSO: 'Nonqualified stock option',
  RSU: 'Restricted stock unit',
};

function text(value) { const element = document.createElement('span'); element.textContent = value ?? ''; return element.innerHTML; }
function formatNumber(value) { return Number(value || 0).toLocaleString(); }
function formatMoney(value) { return Number(value || 0).toLocaleString(undefined, { style: 'currency', currency: 'USD' }); }
function formatDate(value) { return value ? new Date(`${value}T00:00:00`).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : 'Not provided'; }
function showToast(value) { toast.textContent = value; toast.classList.add('show'); window.setTimeout(() => toast.classList.remove('show'), 2200); }

function underlyingGrantNumber(award) {
  if (!['ISO', 'NSO'].includes(award.award_type)) return award.grant_number || `award-${award.id}`;
  return (award.grant_number || '').replace(/^I[SN]-?/i, '') || `award-${award.id}`;
}

function groupedAwards(awards) {
  const groups = new Map();
  awards.forEach((award) => {
    const canSplit = ['ISO', 'NSO'].includes(award.award_type) && award.grant_number;
    const key = canSplit
      ? [award.company.trim().toLowerCase(), underlyingGrantNumber(award).toLowerCase(), award.grant_date, Number(award.strike_price).toFixed(4)].join('|')
      : `award-${award.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(award);
  });
  return [...groups.values()].map((members) => {
    if (members.length === 1 || new Set(members.map((award) => award.award_type)).size === 1) {
      return { ...members[0], _members: members, _split: false };
    }
    const primary = [...members].sort((a, b) => b.shares_granted - a.shares_granted)[0];
    const sum = (field) => members.reduce((total, award) => total + Number(award[field] || 0), 0);
    const events = members.flatMap((award) => (award.vesting_events || []).map((event) => ({
      ...event, tranche_type: award.award_type,
    }))).sort((a, b) => a.vest_date.localeCompare(b.vest_date) || a.id - b.id);
    return {
      ...primary,
      id: members.map((award) => award.id).join('-'),
      grant_number: underlyingGrantNumber(primary),
      award_type: 'ISO/NSO',
      shares_granted: sum('shares_granted'),
      shares_vested: sum('shares_vested'),
      shares_unvested: sum('shares_unvested'),
      shares_exercised: sum('shares_exercised'),
      shares_sold: sum('shares_sold'),
      shares_canceled: sum('shares_canceled'),
      shares_available: sum('shares_available'),
      shares_planned_for_sale: sum('shares_planned_for_sale'),
      vesting_events: events,
      vesting_schedule: `${events.length} combined vesting events`,
      _members: members,
      _split: true,
    };
  });
}

function holdingPeriodLabel(lot) {
  if (!lot.holding_period_start) return 'Unknown';
  const days = Math.floor((chartDate(asOfInput.value) - chartDate(lot.holding_period_start)) / 86400000);
  return days > 365 ? 'Long-term' : `${Math.max(0, days)} days`;
}

function lotHistoryRows(lot) {
  return lot.transaction_history.map((item) => `<tr><td>${formatDate(item.transaction_date)}</td><td>${text(item.transaction_type)}</td><td>${formatNumber(item.shares)}</td><td>${formatMoney(item.price)}</td><td>${formatMoney(item.fees)}</td><td>${text(item.notes || '—')}</td></tr>`).join('');
}

function inlineLots(lots) {
  if (!lots.length) return '<div class="award-holdings-empty">No shares acquired from this grant yet.</div>';
  const rows = lots.map((lot) => `<tr>
    <td><strong>${formatDate(lot.acquisition_date)}</strong><small>${text(lot.acquisition_type)}</small></td>
    <td>${formatNumber(lot.shares_acquired)}</td><td><strong>${formatNumber(lot.shares_remaining)}</strong></td>
    <td>${formatMoney(lot.regular_tax_basis_per_share)}</td><td>${formatMoney(lot.amt_basis_per_share)}</td>
    <td><span class="holding-badge ${holdingPeriodLabel(lot) === 'Long-term' ? 'long' : ''}">${holdingPeriodLabel(lot)}</span></td>
    <td><div class="inline-lot-actions">${lot.exercise_id ? `<a href="/exercises?edit_id=${lot.exercise_id}">Edit exercise</a>` : ''}<button class="plain-button" type="button" data-inline-lot="${lot.id}" aria-expanded="false">Details</button></div></td>
  </tr><tr class="inline-lot-history" data-inline-history="${lot.id}" hidden><td colspan="7">
    <div class="lot-basis-inline"><span>Regular basis <strong>${formatMoney(lot.regular_tax_basis)}</strong></span><span>AMT basis <strong>${formatMoney(lot.amt_basis)}</strong></span><span>Holding-period start <strong>${formatDate(lot.holding_period_start)}</strong></span><span>QSBS start <strong>${formatDate(lot.qsbs_holding_period_start)}</strong></span></div>
    <table class="lots-table"><thead><tr><th>Date</th><th>Transaction</th><th>Shares</th><th>Price</th><th>Fees</th><th>Notes</th></tr></thead><tbody>${lotHistoryRows(lot)}</tbody></table>
  </td></tr>`).join('');
  return `<div class="award-lots-table"><table><thead><tr><th>Acquired</th><th>Original</th><th>Held</th><th>Regular basis/share</th><th>AMT basis/share</th><th>Holding period</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function renderAllLots() {
  document.querySelector('#allLotsCount').textContent = `${savedLots.length} lot${savedLots.length === 1 ? '' : 's'}`;
  document.querySelector('#sharesAcquired').textContent = formatNumber(savedLots.reduce((sum, lot) => sum + lot.shares_acquired, 0));
  document.querySelector('#sharesSold').textContent = formatNumber(savedLots.reduce((sum, lot) => sum + lot.shares_sold, 0));
  document.querySelector('#sharesRemaining').textContent = formatNumber(savedLots.reduce((sum, lot) => sum + lot.shares_remaining, 0));
  const filter = document.querySelector('#lotFilter').value;
  const visible = filter === 'All' ? savedLots : savedLots.filter((lot) => lot.status === filter);
  document.querySelector('#lotsBody').innerHTML = visible.length ? visible.map((lot) => `<article class="lot-card">
    <div class="lot-heading"><div><h2>${text(lot.company || 'Unknown company')}</h2><p>${text(lot.security || 'Unknown security')} · ${text(lot.acquisition_type)}${lot.grant_number ? ` · Grant ${text(lot.grant_number)}` : ''}</p></div><span class="lot-status ${lot.status === 'Fully sold' ? 'sold' : ''}">${text(lot.status)}</span></div>
    <div class="lot-share-grid"><div><span>Acquisition date</span><strong>${formatDate(lot.acquisition_date)}</strong></div><div><span>Original shares</span><strong>${formatNumber(lot.shares_acquired)}</strong></div><div><span>Shares sold</span><strong>${formatNumber(lot.shares_sold)}</strong></div><div><span>Remaining shares</span><strong>${formatNumber(lot.shares_remaining)}</strong></div><div><span>FMV at acquisition</span><strong>${formatMoney(lot.fmv_at_acquisition)}</strong></div></div>
    <div class="lot-basis-grid"><div><span>Regular basis / share</span><strong>${formatMoney(lot.regular_tax_basis_per_share)}</strong></div><div><span>Total regular basis</span><strong>${formatMoney(lot.regular_tax_basis)}</strong></div><div><span>AMT basis / share</span><strong>${formatMoney(lot.amt_basis_per_share)}</strong></div><div><span>Total AMT basis</span><strong>${formatMoney(lot.amt_basis)}</strong></div></div>
    <button class="secondary-button all-lot-history-toggle" type="button" data-all-lot="${lot.id}" aria-expanded="false">View transaction history (${lot.transaction_history.length})</button>
    <div class="lot-history" data-all-lot-history="${lot.id}" hidden><div class="lots-table-wrap"><table class="lots-table"><thead><tr><th>Date</th><th>Transaction</th><th>Shares</th><th>Price</th><th>Fees</th><th>Notes</th></tr></thead><tbody>${lotHistoryRows(lot)}</tbody></table></div></div>
  </article>`).join('') : '<div class="empty-state"><h2>No lots found</h2><p>Record a completed exercise or RSU settlement to create a holding.</p></div>';
}

function chartDate(value) { return new Date(`${value}T00:00:00`); }
function shortChartDate(value) { return chartDate(value).toLocaleDateString(undefined, { month: 'short', year: '2-digit' }); }

function vestingChart(events, asOf, mode = 'cumulative') {
  if (!events.length) return '<div class="chart-empty">Add vesting events to see the schedule.</div>';
  const grouped = new Map();
  events.forEach((event) => {
    let key = event.vest_date;
    if (mode === 'period') {
      const [year, month] = event.vest_date.split('-').map(Number);
      const quarterMonth = String(Math.floor((month - 1) / 3) * 3 + 1).padStart(2, '0');
      key = `${year}-${quarterMonth}-01`;
    }
    grouped.set(key, (grouped.get(key) || 0) + Number(event.shares || 0));
  });
  const entries = [...grouped].sort(([a], [b]) => a.localeCompare(b));
  const width = 900; const height = 250; const left = 64; const right = 20; const top = 18; const bottom = 42;
  const start = chartDate(entries[0][0]); const end = chartDate(entries[entries.length - 1][0]);
  const span = Math.max(1, end - start); const asOfTime = chartDate(asOf).getTime();
  let running = 0;
  const points = entries.map(([dateValue, shares]) => {
    running += shares;
    return { date: dateValue, time: chartDate(dateValue).getTime(), value: mode === 'cumulative' ? running : shares };
  });
  const max = Math.max(...points.map((point) => point.value), 1);
  const x = (time) => left + (time - start.getTime()) / span * (width - left - right);
  const y = (value) => top + (1 - value / max) * (height - top - bottom);
  const path = points.map((point, index) => `${index ? 'L' : 'M'} ${x(point.time).toFixed(1)} ${y(point.value).toFixed(1)}`).join(' ');
  const past = points.filter((point) => point.time <= asOfTime);
  const future = points.filter((point) => point.time > asOfTime);
  const futurePoints = past.length ? [past[past.length - 1], ...future] : future;
  const pastPath = past.map((point, index) => `${index ? 'L' : 'M'} ${x(point.time).toFixed(1)} ${y(point.value).toFixed(1)}`).join(' ');
  const futurePath = futurePoints.map((point, index) => `${index ? 'L' : 'M'} ${x(point.time).toFixed(1)} ${y(point.value).toFixed(1)}`).join(' ');
  const todayX = Math.max(left, Math.min(width - right, x(asOfTime)));
  const ticks = [0, .25, .5, .75, 1].map((ratio) => {
    const tickY = top + ratio * (height - top - bottom);
    return `<line x1="${left}" y1="${tickY}" x2="${width - right}" y2="${tickY}" class="chart-grid"/><text x="${left - 10}" y="${tickY + 4}" text-anchor="end">${formatNumber(Math.round(max * (1 - ratio)))}</text>`;
  }).join('');
  const dateTicks = [0, .25, .5, .75, 1].map((ratio) => {
    const time = start.getTime() + span * ratio;
    return `<text x="${left + (width - left - right) * ratio}" y="${height - 14}" text-anchor="${ratio === 0 ? 'start' : ratio === 1 ? 'end' : 'middle'}">${shortChartDate(new Date(time).toISOString().slice(0, 10))}</text>`;
  }).join('');
  const dots = points.map((point) => `<circle cx="${x(point.time)}" cy="${y(point.value)}" r="4" class="chart-dot ${point.time <= asOfTime ? 'vested' : 'scheduled'}"><title>${formatDate(point.date)}: ${formatNumber(point.value)} ${mode === 'cumulative' ? 'cumulative' : 'vesting'} shares</title></circle>`).join('');
  const bars = points.map((point) => {
    const barWidth = Math.max(5, Math.min(28, (width - left - right) / points.length * .55));
    return `<rect x="${x(point.time) - barWidth / 2}" y="${y(point.value)}" width="${barWidth}" height="${height - bottom - y(point.value)}" rx="3" class="chart-bar ${point.time <= asOfTime ? 'vested' : 'scheduled'}"><title>${formatDate(point.date)}: ${formatNumber(point.value)} shares</title></rect>`;
  }).join('');
  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true"><g class="chart-axis">${ticks}${dateTicks}</g>
    ${mode === 'period' ? bars : `<path d="${path} L ${x(points[points.length - 1].time)} ${height - bottom} L ${x(points[0].time)} ${height - bottom} Z" class="chart-area"/><path d="${pastPath}" class="chart-line vested"/><path d="${futurePath}" class="chart-line scheduled"/>${dots}`}
    <line x1="${todayX}" y1="${top}" x2="${todayX}" y2="${height - bottom}" class="today-line"/><text x="${todayX + 6}" y="${top + 10}" class="today-label">AS OF</text></svg>`;
}

function renderPortfolioVestingChart() {
  const type = document.querySelector('#vestingTypeFilter').value;
  const awards = savedAwards.filter((award) => type === 'all' || award.award_type === type);
  const events = awards.flatMap((award) => award.vesting_events || []);
  const total = events.reduce((sum, event) => sum + Number(event.shares || 0), 0);
  const vested = events.filter((event) => event.vest_date <= asOfInput.value).reduce((sum, event) => sum + Number(event.shares || 0), 0);
  const next = events.filter((event) => event.vest_date > asOfInput.value).sort((a, b) => a.vest_date.localeCompare(b.vest_date))[0];
  document.querySelector('#vestingChartSummary').innerHTML = `<div><span>Vested</span><strong>${formatNumber(vested)}</strong></div><div><span>Scheduled</span><strong>${formatNumber(Math.max(0, total - vested))}</strong></div><div><span>Next vest</span><strong>${next ? `${formatNumber(next.shares)} · ${formatDate(next.vest_date)}` : 'Fully vested'}</strong></div>`;
  document.querySelector('#portfolioVestingChart').innerHTML = vestingChart(events, asOfInput.value, chartMode);
}

function renderGrantCharts(displayAwards) {
  awardsList.querySelectorAll('[data-award-id]').forEach((card) => {
    const award = displayAwards.find((item) => String(item.id) === card.dataset.awardId);
    if (!award) return;
    const events = award.vesting_events || [];
    const vested = events.filter((event) => event.vest_date <= asOfInput.value).reduce((sum, event) => sum + Number(event.shares || 0), 0);
    const future = events.filter((event) => event.vest_date > asOfInput.value).sort((a, b) => a.vest_date.localeCompare(b.vest_date));
    const fullyVested = events.length ? events[events.length - 1].vest_date : null;
    card.querySelector('[data-grant-chart-summary]').innerHTML = `<div><span>Granted</span><strong>${formatNumber(award.shares_granted)}</strong></div><div><span>Vested</span><strong>${formatNumber(vested)}</strong></div><div><span>Next vest</span><strong>${future.length ? `${formatNumber(future[0].shares)} · ${formatDate(future[0].vest_date)}` : 'None'}</strong></div><div><span>Fully vested</span><strong>${fullyVested ? formatDate(fullyVested) : 'Not scheduled'}</strong></div>`;
    card.querySelector('[data-grant-chart]').innerHTML = vestingChart(events, asOfInput.value);
  });
}

function addVestingEvent(event = {}) {
  const row = document.createElement('tr');
  row.className = 'vesting-event-row';
  row.innerHTML = `
    <td><input type="date" data-vest-date value="${text(event.vest_date || '')}" required></td>
    <td><input type="number" data-vest-shares min="0.0001" step="0.0001" value="${text(event.shares || '')}" required></td>
    <td><button class="plain-button remove-vesting-event" type="button">Remove</button></td>`;
  vestingEvents.appendChild(row);
}

function addMonths(dateValue, months) {
  const [year, month, day] = dateValue.split('-').map(Number);
  const result = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result.toISOString().slice(0, 10);
}

function updateScheduleBuilder() {
  const type = document.querySelector('#scheduleType').value;
  const custom = type === 'custom';
  document.querySelector('#scheduleStart').disabled = custom;
  document.querySelector('#scheduleDuration').disabled = custom;
  document.querySelector('#scheduleCliff').disabled = custom;
  document.querySelector('#cliffField').hidden = type !== 'cliff-monthly';
  document.querySelector('#addVestingEvent').hidden = !custom;
  vestingEvents.querySelectorAll('input, button').forEach((control) => { control.disabled = !custom; });
  updateSchedule();
}

function scheduleDescription() {
  const type = document.querySelector('#scheduleType').value;
  const duration = Number(document.querySelector('#scheduleDuration').value);
  if (type === 'custom') return `${vestingEvents.children.length} custom vesting event${vestingEvents.children.length === 1 ? '' : 's'}`;
  const names = { monthly: 'Monthly', quarterly: 'Quarterly', annual: 'Annual', 'cliff-monthly': 'Monthly' };
  const years = duration && duration % 12 === 0 ? `${duration / 12} year${duration === 12 ? '' : 's'}` : `${duration || 0} months`;
  return type === 'cliff-monthly' ? `${years}, monthly, ${document.querySelector('#scheduleCliff').value || 12}-month cliff` : `${years}, ${names[type].toLowerCase()}`;
}

function updateLiveSummary() {
  const granted = Number(awardForm.elements.shares_granted.value || 0);
  const canceled = Number(awardForm.elements.shares_canceled.value || 0);
  const vested = [...vestingEvents.querySelectorAll('.vesting-event-row')].reduce((sum, row) => {
    return sum + (row.querySelector('[data-vest-date]').value <= asOfInput.value ? Number(row.querySelector('[data-vest-shares]').value || 0) : 0);
  }, 0);
  const current = savedAwards.find((award) => award.id === editingAwardId);
  const exercised = current?.shares_exercised || 0;
  document.querySelector('#formGranted').textContent = formatNumber(granted);
  document.querySelector('#formVested').textContent = formatNumber(vested);
  document.querySelector('#formAvailable').textContent = formatNumber(Math.max(0, vested - exercised));
  document.querySelector('#formUnvested').textContent = formatNumber(Math.max(0, granted - vested - canceled));
  document.querySelector('#formAvailableLabel').textContent = awardForm.elements.award_type.value === 'RSU' ? 'Available' : 'Exercisable';
  const summary = scheduleDescription();
  document.querySelector('#scheduleSummary').textContent = summary;
  awardForm.elements.vesting_schedule.value = summary;
}

function updateSchedule() {
  const type = document.querySelector('#scheduleType').value;
  if (type === 'custom') { updateLiveSummary(); return; }
  const start = document.querySelector('#scheduleStart').value;
  const duration = Number(document.querySelector('#scheduleDuration').value);
  const granted = Number(awardForm.elements.shares_granted.value);
  if (!start || duration < 1 || granted <= 0) {
    vestingEvents.innerHTML = '';
    updateLiveSummary();
    return;
  }
  const interval = type === 'quarterly' ? 3 : type === 'annual' ? 12 : 1;
  const cliff = type === 'cliff-monthly' ? Math.min(duration, Number(document.querySelector('#scheduleCliff').value || 12)) : interval;
  vestingEvents.innerHTML = '';
  const offsets = [];
  for (let month = cliff; month <= duration; month += interval) offsets.push(month);
  if (offsets[offsets.length - 1] !== duration) offsets.push(duration);
  let allocated = 0;
  offsets.forEach((month, index) => {
    const priorMonth = index ? offsets[index - 1] : 0;
    const shares = index === offsets.length - 1
      ? granted - allocated
      : Number((granted * (month - priorMonth) / duration).toFixed(4));
    allocated += shares;
    addVestingEvent({ vest_date: addMonths(start, month), shares });
  });
  vestingEvents.querySelectorAll('input, button').forEach((control) => { control.disabled = true; });
  updateLiveSummary();
}

function toggleOptionFields() {
  const isOption = awardForm.elements.award_type.value !== 'RSU';
  document.querySelectorAll('.option-field').forEach((field) => { field.hidden = !isOption; });
  awardForm.elements.strike_price.required = isOption;
  if (!isOption) {
    awardForm.elements.expiration_date.value = '';
    awardForm.elements.strike_price.value = '0';
  }
  updateLiveSummary();
}

function showForm() {
  awardFormCard.hidden = false;
  document.querySelector('#openAwardForm').hidden = true;
  awardFormCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function hideForm() {
  awardFormCard.hidden = true;
  document.querySelector('#openAwardForm').hidden = false;
  formMessage.textContent = '';
}
function resetAwardForm() {
  editingAwardId = null;
  awardForm.reset();
  vestingEvents.innerHTML = '';
  toggleOptionFields();
  updateScheduleBuilder();
  updateLiveSummary();
  document.querySelector('#awardFormTitle').textContent = 'Add equity award';
  document.querySelector('#awardSubmitButton').textContent = 'Save award';
}

function renderAwards(awards) {
  savedAwards = awards;
  const displayAwards = groupedAwards(awards);
  document.querySelector('#awardCount').textContent = displayAwards.length;
  document.querySelector('#totalGranted').textContent = formatNumber(awards.reduce((sum, award) => sum + award.shares_granted, 0));
  document.querySelector('#totalVested').textContent = formatNumber(awards.reduce((sum, award) => sum + award.shares_vested, 0));
  document.querySelector('#totalRemaining').textContent = formatNumber(awards.reduce((sum, award) => sum + award.shares_available, 0));
  if (!awards.length) {
    awardsList.innerHTML = '<div class="empty-state"><h2>No equity awards yet</h2><p>Add your first award to begin tracking it.</p></div>';
    renderPortfolioVestingChart();
    return;
  }
  awardsList.innerHTML = displayAwards.map((award) => {
    const memberIds = new Set(award._members.map((member) => member.id));
    const awardLots = savedLots.filter((lot) => memberIds.has(lot.source_award_id));
    const sharesHeld = awardLots.reduce((sum, lot) => sum + Number(lot.shares_remaining || 0), 0);
    const sharesAcquired = awardLots.reduce((sum, lot) => sum + Number(lot.shares_acquired || 0), 0);
    const percent = award.shares_granted ? Math.min(100, award.shares_vested / award.shares_granted * 100) : 0;
    const scheduleRows = award.vesting_events.length ? award.vesting_events.map((event) => {
      const vested = event.vest_date <= asOfInput.value;
      const canSettle = award.award_type === 'RSU' && event.vest_date <= new Date().toISOString().slice(0, 10);
      return `<tr><td>${formatDate(event.vest_date)}</td><td>${formatNumber(event.shares)}${event.tranche_type ? ` <small class="tranche-label">${event.tranche_type}</small>` : ''}</td><td>${event.settled ? 'Settled' : vested ? 'Vested' : 'Scheduled'}</td><td>${canSettle && !event.settled ? `<button class="secondary-button" type="button" data-settle="${event.id}">Create acquisition lot</button>` : event.settled ? 'Lot created' : '—'}</td></tr>`;
    }).join('') : '<tr><td colspan="4">No structured vesting events</td></tr>';
    const badges = award._members.map((member) => `<span class="type-badge">${text(awardNames[member.award_type] || member.award_type)}</span>`).join('');
    const actions = award._split
      ? award._members.map((member) => `<span class="tranche-actions"><b>${member.award_type}</b><button type="button" data-edit="${member.id}">Edit</button><button class="delete-button" type="button" data-delete="${member.id}">Delete</button></span>`).join('')
      : `<button type="button" data-edit="${award._members[0].id}">Edit</button><button class="delete-button" type="button" data-delete="${award._members[0].id}">Delete</button>`;
    const exerciseActions = award._members.filter((member) => member.award_type !== 'RSU').map((member) => `<a class="secondary-button" href="/exercises?award_id=${member.id}">Add${award._split ? ` ${member.award_type}` : ''} exercise</a>`).join('');
    return `
      <article class="award-card" data-award-id="${award.id}">
        <div class="award-title">
          <div><h2>${text(award.company)}</h2><p>${text(award.security)}${award.grant_number ? ` · Grant ${text(award.grant_number)}` : ''}${award._split ? ' · ISO/NSO split' : ''}</p></div>
          <div class="award-actions">${badges}${actions}</div>
        </div>
        <div class="award-details">
          <div><span>Grant date</span><strong>${formatDate(award.grant_date)}</strong></div>
          <div><span>Expiration</span><strong>${award.award_type === 'RSU' ? 'Not applicable' : formatDate(award.expiration_date)}</strong></div>
          <div><span>Strike price</span><strong>${award.award_type === 'RSU' ? 'Not applicable' : formatMoney(award.strike_price)}</strong></div>
          <div><span>QSBS status</span><strong>${text(award.qsbs_status)}</strong></div>
        </div>
        <div class="vesting-progress">
          <div><span>${formatNumber(award.shares_vested)} vested · ${formatNumber(award.shares_unvested)} unvested</span><span>${formatNumber(award.shares_granted)} granted</span></div>
          <i><b style="width:${percent}%"></b></i>
        </div>
        <div class="award-share-status">
          <div><span>Vested</span><strong>${formatNumber(award.shares_vested)}</strong></div>
          <div><span>Unvested</span><strong>${formatNumber(award.shares_unvested)}</strong></div>
          <div class="${award.award_type === 'RSU' ? 'not-applicable' : ''}"><span>Exercised</span><strong>${award.award_type === 'RSU' ? 'N/A' : formatNumber(award.shares_exercised)}</strong></div>
          <div class="${award.award_type === 'RSU' ? '' : 'not-applicable'}"><span>Settled</span><strong>${award.award_type === 'RSU' ? formatNumber(sharesAcquired) : 'N/A'}</strong></div>
          <div><span>Held</span><strong>${formatNumber(sharesHeld)}</strong></div>
          <div><span>Sold</span><strong>${formatNumber(award.shares_sold)}</strong></div>
          <div><span>Available</span><strong>${formatNumber(award.shares_available)}</strong></div>
        </div>
        <section class="award-holdings">
          <div class="award-holdings-heading">
            <div><strong>Current holdings</strong><small>${formatNumber(sharesHeld)} shares held across ${awardLots.length} tax lot${awardLots.length === 1 ? '' : 's'}</small></div>
            <div class="award-holdings-actions">${exerciseActions}${awardLots.length ? `<button class="secondary-button" type="button" data-award-lots-toggle aria-expanded="false">View lots</button>` : ''}</div>
          </div>
          <div class="award-holdings-content" data-award-lots-content ${awardLots.length ? 'hidden' : ''}>${inlineLots(awardLots)}</div>
        </section>
        <section class="award-schedule">
          <div class="award-schedule-heading">
            <div><strong>Vesting schedule</strong><small>${text(award.vesting_schedule || `${award.vesting_events.length} custom events`)}</small></div>
            <button class="secondary-button" type="button" data-schedule-toggle aria-expanded="false">Expand schedule</button>
          </div>
          <div class="award-schedule-content" data-schedule-content hidden>
            <div class="grant-chart-summary" data-grant-chart-summary></div>
            <div class="vesting-chart grant-vesting-chart" data-grant-chart role="img" aria-label="${text(award.company)} grant vesting schedule"></div>
            <div class="award-schedule-table"><table><thead><tr><th>Date</th><th>Shares</th><th>Status</th><th>RSU settlement</th></tr></thead><tbody>${scheduleRows}</tbody></table></div>
          </div>
        </section>
        <div class="award-notes">
          ${award.notes ? `<p><strong>Notes:</strong> ${text(award.notes)}</p>` : ''}
          <p><strong>QSBS acquisition:</strong> ${text(award.acquisition_details || 'Not provided')}${award.acquisition_date ? ` (${formatDate(award.acquisition_date)})` : ''}</p>
        </div>
      </article>`;
  }).join('');
  renderPortfolioVestingChart();
  renderGrantCharts(displayAwards);
  const linkedAwardId = Number(new URLSearchParams(window.location.search).get('award_id'));
  if (linkedAwardId) {
    const linkedAward = displayAwards.find((award) => award._members.some((member) => member.id === linkedAwardId));
    const linkedCard = linkedAward ? awardsList.querySelector(`[data-award-id="${linkedAward.id}"]`) : null;
    if (linkedCard) {
      linkedCard.classList.add('linked-award-highlight');
      window.requestAnimationFrame(() => linkedCard.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    }
  }
}

async function loadAwards() {
  try {
    const [awardResponse, lotResponse] = await Promise.all([
      fetch(`/api/awards?as_of=${encodeURIComponent(asOfInput.value)}`, { cache: 'no-store' }),
      fetch('/api/lots', { cache: 'no-store' }),
    ]);
    if (!awardResponse.ok || !lotResponse.ok) throw new Error('Could not load equity data');
    savedLots = await lotResponse.json();
    renderAwards(await awardResponse.json());
    renderAllLots();
  } catch (error) {
    awardsList.innerHTML = `<div class="empty-state"><h2>Could not load awards</h2><p>${text(error.message)}</p></div>`;
  }
}

awardForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  formMessage.textContent = 'Saving...';
  const values = Object.fromEntries(new FormData(awardForm));
  values.shares_vested = '0';
  values.vesting_events = [...vestingEvents.querySelectorAll('.vesting-event-row')].map((row) => ({
    vest_date: row.querySelector('[data-vest-date]').value,
    shares: row.querySelector('[data-vest-shares]').value,
  }));
  try {
    const response = await fetch(editingAwardId ? `/api/awards/${editingAwardId}` : '/api/awards', {
      method: editingAwardId ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(values),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not save award');
    showToast(editingAwardId ? 'Award updated' : 'Award saved');
    resetAwardForm();
    hideForm();
    await loadAwards();
  } catch (error) { formMessage.textContent = error.message; }
});

function editAward(id) {
  const award = savedAwards.find((item) => item.id === id);
  if (!award) return;
  editingAwardId = id;
  Object.entries(award).forEach(([name, value]) => {
    const field = awardForm.elements.namedItem(name);
    if (field) field.value = value ?? '';
  });
  vestingEvents.innerHTML = '';
  award.vesting_events.forEach(addVestingEvent);
  toggleOptionFields();
  updateScheduleBuilder();
  updateLiveSummary();
  document.querySelector('#awardFormTitle').textContent = 'Edit equity award';
  document.querySelector('#awardSubmitButton').textContent = 'Update award';
  showForm();
}

async function deleteAward(id) {
  const award = savedAwards.find((item) => item.id === id);
  if (!award || !window.confirm(`Delete the ${awardNames[award.award_type] || award.award_type} award from ${award.company}?`)) return;
  const response = await fetch(`/api/awards/${id}`, { method: 'DELETE' });
  const result = await response.json();
  if (!response.ok) { window.alert(result.error || 'Could not delete award'); return; }
  if (editingAwardId === id) { resetAwardForm(); hideForm(); }
  showToast('Award deleted');
  await loadAwards();
}

awardsList.addEventListener('click', (event) => {
  const editButton = event.target.closest('[data-edit]');
  const deleteButton = event.target.closest('[data-delete]');
  if (editButton) editAward(Number(editButton.dataset.edit));
  if (deleteButton) deleteAward(Number(deleteButton.dataset.delete));
  const settleButton = event.target.closest('[data-settle]');
  if (settleButton) settleVestingEvent(Number(settleButton.dataset.settle));
  const scheduleButton = event.target.closest('[data-schedule-toggle]');
  if (scheduleButton) {
    const content = scheduleButton.closest('.award-schedule').querySelector('[data-schedule-content]');
    const expanded = scheduleButton.getAttribute('aria-expanded') !== 'true';
    scheduleButton.setAttribute('aria-expanded', String(expanded));
    scheduleButton.textContent = expanded ? 'Collapse schedule' : 'Expand schedule';
    content.hidden = !expanded;
  }
  const holdingsButton = event.target.closest('[data-award-lots-toggle]');
  if (holdingsButton) {
    const content = holdingsButton.closest('.award-holdings').querySelector('[data-award-lots-content]');
    const expanded = holdingsButton.getAttribute('aria-expanded') !== 'true';
    holdingsButton.setAttribute('aria-expanded', String(expanded));
    holdingsButton.textContent = expanded ? 'Hide lots' : 'View lots';
    content.hidden = !expanded;
  }
  const lotButton = event.target.closest('[data-inline-lot]');
  if (lotButton) {
    const row = awardsList.querySelector(`[data-inline-history="${lotButton.dataset.inlineLot}"]`);
    const expanded = lotButton.getAttribute('aria-expanded') !== 'true';
    lotButton.setAttribute('aria-expanded', String(expanded));
    lotButton.textContent = expanded ? 'Hide' : 'Details';
    row.hidden = !expanded;
  }
});
async function settleVestingEvent(eventId) {
  const entered = window.prompt('Enter the fair market value per share on the settlement date:');
  if (entered === null) return;
  const fmv = Number(entered);
  if (!Number.isFinite(fmv) || fmv < 0) { window.alert('Enter a valid nonnegative FMV.'); return; }
  const response = await fetch(`/api/vesting-events/${eventId}/settle`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fmv }),
  });
  const result = await response.json();
  if (!response.ok) { window.alert(result.error || 'Could not create acquisition lot'); return; }
  showToast('RSU acquisition lot created');
  await loadAwards();
}
vestingEvents.addEventListener('click', (event) => {
  const button = event.target.closest('.remove-vesting-event');
  if (button) { button.closest('.vesting-event-row').remove(); updateLiveSummary(); }
});
document.querySelector('#addVestingEvent').addEventListener('click', () => { addVestingEvent(); updateLiveSummary(); });
document.querySelector('#scheduleType').addEventListener('change', updateScheduleBuilder);
['scheduleStart', 'scheduleDuration', 'scheduleCliff'].forEach((id) => document.querySelector(`#${id}`).addEventListener('input', updateSchedule));
awardForm.elements.shares_granted.addEventListener('input', updateSchedule);
awardForm.elements.shares_canceled.addEventListener('input', updateLiveSummary);
vestingEvents.addEventListener('input', updateLiveSummary);
document.querySelector('#awardType').addEventListener('change', toggleOptionFields);
document.querySelector('#openAwardForm').addEventListener('click', () => { resetAwardForm(); showForm(); });
document.querySelector('#closeAwardForm').addEventListener('click', () => { resetAwardForm(); hideForm(); });
asOfInput.value = new Date().toISOString().slice(0, 10);
asOfInput.addEventListener('change', () => { updateLiveSummary(); loadAwards(); });
document.querySelector('#vestingTypeFilter').addEventListener('change', renderPortfolioVestingChart);
document.querySelectorAll('[data-chart-mode]').forEach((button) => button.addEventListener('click', () => {
  chartMode = button.dataset.chartMode;
  document.querySelectorAll('[data-chart-mode]').forEach((item) => item.classList.toggle('selected', item === button));
  renderPortfolioVestingChart();
}));
document.querySelector('#lotFilter').addEventListener('change', renderAllLots);
document.querySelector('#lotsBody').addEventListener('click', (event) => {
  const button = event.target.closest('[data-all-lot]');
  if (!button) return;
  const history = document.querySelector(`[data-all-lot-history="${button.dataset.allLot}"]`);
  const expanded = button.getAttribute('aria-expanded') !== 'true';
  button.setAttribute('aria-expanded', String(expanded));
  button.textContent = expanded ? 'Hide transaction history' : `View transaction history (${history.querySelectorAll('tbody tr').length})`;
  history.hidden = !expanded;
});
resetAwardForm();
loadAwards();
if (['#lots', '#allLots'].includes(window.location.hash)) {
  document.querySelector('#allLots').open = true;
  window.requestAnimationFrame(() => document.querySelector('#allLots').scrollIntoView({ block: 'start' }));
}
